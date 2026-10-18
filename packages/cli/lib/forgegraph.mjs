import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { STARTER_BINDING_TYPES, generateStarterConfig, inspectRepository, starterFaultPoints } from "./project.mjs";
import { fail, filePath, heading, label, pass, warn } from "./terminal.mjs";

const forgegraph = () => import("@cloudfault/forgegraph");
const core = () => import("@cloudfault/core");
const cloudflare = () => import("@cloudfault/cloudflare");

// The same search shape the generated starter config declares.
const BASELINE_PLAN = { strategy: "hybrid", maxDepth: 2, maxScenarios: 100 };
const NOT_EXECUTED = "starter execute() is not implemented, so nothing was executed";

/** `--name value` / `--flag` parsing; repeated flags accumulate. */
export function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split("=", 2);
    const next = args[index + 1];
    const value = inline ?? (next !== undefined && !next.startsWith("--") ? (index++, next) : true);
    flags[name] = name in flags ? [flags[name], value].flat() : value;
  }
  return { flags, positional };
}

function list(value) {
  if (value === undefined || value === true) return [];
  return [value].flat().flatMap((item) => String(item).split(",")).filter(Boolean);
}

/**
 * ForgeGraph credentials: FORGEGRAPH_SERVER/FORGEGRAPH_TOKEN (CI), else the
 * `forge login` credential file. The token is never printed.
 */
export function forgeGraphCredentials(env = process.env) {
  if (env.FORGEGRAPH_TOKEN) return { server: env.FORGEGRAPH_SERVER ?? "https://forgegraf.com", token: env.FORGEGRAPH_TOKEN };
  const file = path.join(env.FORGEGRAPH_HOME ?? path.join(os.homedir(), ".forgegraph"), "credentials.json");
  if (!fs.existsSync(file)) throw new Error("No ForgeGraph credentials: set FORGEGRAPH_TOKEN or run `forge login`");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  return { server: env.FORGEGRAPH_SERVER ?? stored.server, token: stored.token };
}

async function client() {
  const { ForgeGraphClient } = await forgegraph();
  return new ForgeGraphClient({ ...forgeGraphCredentials(), userAgent: "cloudfault-cli" });
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" } }).trim();
}

/** Static and baseline drafts for one checked-out repository. */
export async function repositoryDrafts(root) {
  const { planEvidence, staticCoverageEvidence } = await forgegraph();
  const { planScenarios } = await core();
  const cf = await cloudflare();
  const started = Date.now();
  const workers = inspectRepository(root);
  const inspections = workers.map((worker) => ({
    config: worker.config,
    name: worker.topology?.name,
    bindings: worker.topology?.bindings ?? [],
    adapters: worker.adapters.map((item) => item.adapter),
  }));
  const unreadable = workers.filter((worker) => !worker.topology).map((worker) => worker.config);
  const staticDraft = staticCoverageEvidence(inspections, { supportedBindingTypes: STARTER_BINDING_TYPES, durationMs: Date.now() - started });
  if (unreadable.length) staticDraft.coverageSummary += `; unreadable (needs wrangler): ${unreadable.join(", ")}`;

  const planStarted = Date.now();
  const points = workers.flatMap((worker) => starterFaultPoints(worker.topology?.bindings ?? [], cf, workers.length > 1 ? `${worker.config}#` : ""));
  const plan = planScenarios(points, BASELINE_PLAN);
  const baselineDraft = planEvidence(plan, { reason: NOT_EXECUTED, durationMs: Date.now() - planStarted });
  return { workers, inspections, staticDraft, baselineDraft, plan };
}

/**
 * Binds drafts to a changeset and pushes them, unless doing so could set
 * delivery in motion. A merged changeset whose repository has a non-manual
 * lane is the dangerous case: ForgeGraph re-evaluates those lanes whenever a
 * passed/failed run lands, and can create a deployment or an approval request
 * for an already-shipped commit. Open changesets push normally — feeding their
 * gates is the point of the evidence.
 */
export async function pushDrafts(fg, { app, sha, changeset, drafts, allowDispatch = false, dryRun = false, policies }) {
  const { dispatchExposure, evidenceRunId, toTestRunEvidence } = await forgegraph();
  const exposure = dispatchExposure(policies ?? []);
  const results = [];
  for (const draft of drafts) {
    const evidence = toTestRunEvidence(draft, { changesetId: changeset.id, externalRunId: evidenceRunId(draft.suiteName, app, sha) });
    const terminal = draft.status === "passed" || draft.status === "failed";
    const blocked = terminal && changeset.status === "merged" && !exposure.safe && !allowDispatch;
    if (dryRun || blocked) {
      results.push({ evidence, pushed: false, reason: dryRun ? "dry run" : `could trigger dispatch (${exposure.reasons.join(", ")})` });
      continue;
    }
    const response = await fg.pushTestRun(evidence);
    results.push({ evidence, pushed: true, testRunId: response?.testRunId });
  }
  return { exposure, results };
}

function printPushResults(results) {
  for (const result of results) {
    const evidence = result.evidence;
    const counts = `${evidence.passedTests} passed, ${evidence.failedTests} failed, ${evidence.skippedTests} skipped of ${evidence.totalTests}`;
    const state = result.pushed ? pass("pushed") : warn("not pushed");
    console.log(`${state} ${evidence.suiteName} [${evidence.status}] ${counts}${result.reason ? ` — ${result.reason}` : ""}`);
    console.log(`  ${label(evidence.coverageSummary)}`);
  }
}

async function resolveChangeset(fg, flags, app, sha) {
  if (typeof flags.changeset === "string") return fg.changeset(flags.changeset);
  const changeset = await fg.changesetForSha(app, sha);
  if (!changeset) throw new Error(`No ForgeGraph changeset for ${app} at ${sha}; pass --changeset <id>`);
  return changeset;
}

/**
 * cloudfault evidence <static|baseline> [path] --app <slug> [--sha <sha>] [--changeset <id>] [--dry-run] [--allow-dispatch]
 * cloudfault evidence run <config> ... (handled by the v4 entrypoint, which owns execution)
 */
export async function evidenceCommand(args, options = {}) {
  const { flags, positional } = parseFlags(args);
  const [suite, target = "."] = positional;
  if (!["static", "baseline", "run"].includes(suite)) throw new Error("usage: cloudfault evidence <static|baseline|run> [path|config] --app <slug>");
  if (typeof flags.app !== "string") throw new Error("--app <slug> is required");
  const root = suite === "run" ? path.dirname(path.resolve(target)) : path.resolve(target);
  const sha = typeof flags.sha === "string" ? flags.sha : git(root, "rev-parse", "HEAD");

  let drafts;
  if (suite === "run") drafts = [await options.runDraft(target)];
  else {
    const { staticDraft, baselineDraft } = await repositoryDrafts(root);
    drafts = [suite === "static" ? staticDraft : baselineDraft];
  }

  const fg = await client();
  const changeset = await resolveChangeset(fg, flags, flags.app, sha);
  const app = await fg.app(flags.app);
  const policies = app.repositoryId ? await fg.executionPolicies(app.repositoryId) : [];
  console.log(`${heading("CloudFault evidence")} — ${flags.app} @ ${sha.slice(0, 12)} → changeset ${changeset.id} (${changeset.status})`);
  const { results } = await pushDrafts(fg, {
    app: flags.app, sha, changeset, drafts, policies,
    allowDispatch: Boolean(flags["allow-dispatch"]),
    dryRun: Boolean(flags["dry-run"]),
  });
  printPushResults(results);
  if (typeof flags.out === "string") fs.writeFileSync(path.resolve(flags.out), `${JSON.stringify(results, null, 2)}\n`);
  if (results.some((result) => !result.pushed && result.reason !== "dry run")) process.exitCode = 2;
}

function cloneUrl(app, gitBase) {
  if (app.flakeRef?.startsWith("git+https://")) return `${app.flakeRef.slice(4).replace(/\?.*$/, "").replace(/\.git$/, "")}.git`;
  return `${gitBase.replace(/\/+$/, "")}/${app.repositoryOwner}/${app.repositoryName}.git`;
}

function checkout(remote, branch, sha, directory) {
  if (fs.existsSync(path.join(directory, ".git"))) {
    try { if (git(directory, "rev-parse", "HEAD") === sha) return; } catch { /* re-clone below */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  git(path.dirname(directory), "clone", "--quiet", "--depth", "1", "--single-branch", "--branch", branch, remote, directory);
}

async function sweepApp(fg, app, options) {
  const record = { app: app.slug, name: app.name, outcome: "pending" };
  if (!app.repositoryOwner || !app.repositoryName) return { ...record, outcome: "skipped", reason: "no linked repository" };
  const remote = cloneUrl(app, options.gitBase);
  const branch = app.repositoryDefaultBranch || "main";
  Object.assign(record, { repository: `${app.repositoryOwner}/${app.repositoryName}`, branch });
  try {
    const line = git(os.tmpdir(), "ls-remote", remote, `refs/heads/${branch}`);
    record.sha = line.split(/\s+/)[0];
    if (!record.sha) return { ...record, outcome: "skipped", reason: `branch ${branch} not found` };
    const directory = path.join(options.workDir, app.slug);
    checkout(remote, branch, record.sha, directory);

    const { workers, inspections, staticDraft, baselineDraft, plan } = await repositoryDrafts(directory);
    record.workers = inspections;
    record.plannedScenarios = plan.scenarios.length;
    record.existingConfigs = workers.filter((worker) => fs.existsSync(path.join(worker.directory, "cloudfault.config.mjs"))).map((worker) => worker.config);
    // Generate the starter config beside each Worker in the scratch clone (never in the app's repository).
    for (const worker of workers) {
      const configPath = path.join(worker.directory, "cloudfault.config.mjs");
      if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, generateStarterConfig({ topology: worker.topology, adapters: worker.adapters, wrangler: worker.wrangler }));
    }

    const changeset = await fg.changesetForSha(app.slug, record.sha);
    const policies = app.repositoryId ? await fg.executionPolicies(app.repositoryId) : [];
    record.policies = policies;
    if (!changeset) {
      const { evidenceRunId, toTestRunEvidence } = await forgegraph();
      record.evidence = [staticDraft, baselineDraft].map((draft) => ({ evidence: toTestRunEvidence(draft, { changesetId: "(none)", externalRunId: evidenceRunId(draft.suiteName, app.slug, record.sha) }), pushed: false, reason: "no changeset for main head" }));
      return { ...record, outcome: "no-changeset", reason: `no changeset has head ${record.sha.slice(0, 12)}` };
    }
    record.changeset = { id: changeset.id, status: changeset.status, title: changeset.title };
    const { dispatchExposure } = await forgegraph();
    const exposure = dispatchExposure(policies);
    // The sweep holds back every suite for an exposed app, not only terminal ones: one decision per app.
    const pushAllowed = options.push && exposure.safe;
    const { results } = await pushDrafts(fg, {
      app: app.slug, sha: record.sha, changeset, policies,
      drafts: [staticDraft, baselineDraft],
      dryRun: !pushAllowed,
    });
    record.evidence = results.map((result) => (!result.pushed && !exposure.safe ? { ...result, reason: `held: ${exposure.reasons.join(", ")}` } : result));
    const outcome = results.every((result) => result.pushed) ? "pushed" : exposure.safe ? "dry-run" : "held";
    return { ...record, outcome, reason: exposure.safe ? undefined : exposure.reasons.join(", ") };
  } catch (error) {
    return { ...record, outcome: "error", reason: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

async function pool(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

function sweepRow(record) {
  const staticEvidence = record.evidence?.find((item) => item.evidence.suiteName === "cloudfault:static")?.evidence;
  const coverage = staticEvidence ? `${staticEvidence.passedTests}/${staticEvidence.totalTests}` : "-";
  const marker = { pushed: pass("pushed"), "dry-run": label("dry-run"), held: warn("held"), "no-changeset": warn("no-cs"), skipped: label("skipped"), error: fail("error") }[record.outcome] ?? record.outcome;
  return `${record.app.padEnd(22)} ${String(record.workers?.length ?? "-").padStart(3)} ${coverage.padStart(7)} ${String(record.plannedScenarios ?? "-").padStart(5)}  ${marker}${record.reason ? `  ${label(record.reason)}` : ""}`;
}

/**
 * cloudfault fleet [--platform cloudflare-workers] [--app a,b] [--push] [--work-dir dir] [--out file] [--concurrency n]
 *
 * Checks out each app's default-branch head into a scratch directory, runs the
 * static inspection and the baseline plan, and binds both to the changeset
 * whose head is that commit. Without --push nothing is posted.
 */
export async function fleetCommand(args) {
  const { flags } = parseFlags(args);
  const platform = typeof flags.platform === "string" ? flags.platform : "cloudflare-workers";
  const only = new Set(list(flags.app));
  const workDir = path.resolve(typeof flags["work-dir"] === "string" ? flags["work-dir"] : path.join(os.tmpdir(), "cloudfault-fleet"));
  const fg = await client();
  const apps = (await fg.apps())
    .filter((app) => app.deploymentPlatform === platform)
    .filter((app) => !only.size || only.has(app.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  console.log(`${heading("CloudFault fleet sweep")} — ${apps.length} ${platform} apps${flags.push ? "" : " (dry run; pass --push to post evidence)"}`);
  console.log(`${label("Scratch checkouts:")} ${filePath(workDir)}\n`);
  console.log(label(`${"APP".padEnd(22)} ${"WKR".padStart(3)} ${"STATIC".padStart(7)} ${"PLAN".padStart(5)}  OUTCOME`));
  const options = { push: Boolean(flags.push), workDir, gitBase: typeof flags["git-base"] === "string" ? flags["git-base"] : "https://git.forgegraf.com" };
  const records = await pool(apps, Number(flags.concurrency ?? 4), async (app) => {
    const record = await sweepApp(fg, app, options);
    console.log(sweepRow(record));
    return record;
  });
  const out = path.resolve(typeof flags.out === "string" ? flags.out : path.join(workDir, "fleet-results.json"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ schema: "cloudfault.fleet", version: 1, platform, generatedAt: new Date().toISOString(), records }, null, 2)}\n`);
  const counts = Object.groupBy(records, (record) => record.outcome);
  console.log(`\n${Object.entries(counts).map(([outcome, items]) => `${outcome}=${items.length}`).join("  ")}`);
  console.log(`${label("Results:")} ${filePath(out)}`);
  if (counts.error?.length) process.exitCode = 1;
}
