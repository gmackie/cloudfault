import fs from "node:fs";
import path from "node:path";
import { parseFlags } from "./flags.mjs";
import { DEFAULT_REGRESSION_DIRECTORY, replayPins } from "./regressions.mjs";
import { DEFAULT_REPORT_DIRECTORY, configOverrides, displayPath, runSuite } from "./run.mjs";
import { fail, filePath, label, pass, paint, warn } from "./terminal.mjs";

const core = () => import("@cloudfault/core");

export const EXIT = { pass: 0, failure: 1, incomplete: 2, error: 3 };

const CONFIG_NAMES = new Set(["cloudfault.config.mjs", "cloudfault.config.js"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".cloudfault", ".wrangler", "dist"]);
const GLOB = /[*?[{]/;

function ignored(file) {
  return file.split(/[\\/]/).some((part) => IGNORED_DIRECTORIES.has(part));
}

function walk(directory, found) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!IGNORED_DIRECTORIES.has(entry.name)) walk(file, found); }
    else if (CONFIG_NAMES.has(entry.name)) found.add(file);
  }
}

/**
 * Config modules to run: explicit files, directories searched for
 * `cloudfault.config.{mjs,js}`, and glob patterns. No targets means the
 * working directory. Order follows the targets; duplicates are dropped.
 */
export function discoverConfigs(targets, cwd = process.cwd()) {
  const found = new Set();
  for (const target of targets.length ? targets : ["."]) {
    if (GLOB.test(target)) {
      if (typeof fs.globSync !== "function") throw new Error(`Glob patterns need Node 22+; pass files or directories instead of '${target}'`);
      for (const match of fs.globSync(target, { cwd }).sort()) if (!ignored(match)) found.add(path.resolve(cwd, match));
      continue;
    }
    const absolute = path.resolve(cwd, target);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (!stat) throw new Error(`No such config file or directory: ${target}`);
    if (stat.isDirectory()) walk(absolute, found);
    else found.add(absolute);
  }
  return [...found];
}

/** Failures beat tool errors beat (strict) incompleteness. */
export function exitCodeFor(records, { strict = false } = {}) {
  if (records.some((record) => record.status === "fail" || record.status === "reproduced")) return EXIT.failure;
  if (records.some((record) => record.status === "error")) return EXIT.error;
  if (strict && records.some((record) => record.status === "incomplete")) return EXIT.incomplete;
  return EXIT.pass;
}

const VERDICT = { [EXIT.pass]: "pass", [EXIT.failure]: "fail", [EXIT.incomplete]: "incomplete", [EXIT.error]: "error" };

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function relativeOrUndefined(file, base) {
  return file ? displayPath(file, base) : undefined;
}

/** The JSON shape of one search/pin result in `summary.json`. */
function summarizeRecord(record, cwd) {
  if (record.kind === "pin") {
    return {
      kind: "pin",
      name: record.name,
      file: relativeOrUndefined(record.file, cwd),
      status: record.status,
      minimalFailureSet: (record.artifact?.minimalFailureSet ?? record.artifact?.scenario.perturbations ?? []).map((item) => item.id),
      failedCheckers: record.run?.checks.filter((check) => !check.valid).map((check) => check.checker) ?? [],
      durationMs: record.durationMs,
      error: record.error ? errorMessage(record.error) : undefined,
    };
  }
  const failing = record.outcome?.failingRun;
  return {
    kind: "search",
    name: record.name,
    module: relativeOrUndefined(record.module && path.resolve(cwd, record.module), cwd),
    status: record.status,
    seed: record.config?.seed,
    strategy: record.plan?.strategy,
    plannedScenarios: record.plan?.scenarios.length,
    executedScenarios: record.result?.runs.length,
    skipped: record.outcome?.skipped,
    baselineFailed: record.outcome?.baselineFailed,
    minimalFailureSet: record.outcome?.minimalFailureSet?.map((item) => item.id),
    failedCheckers: failing?.checks.filter((check) => !check.valid).map((check) => check.checker),
    artifact: relativeOrUndefined(record.failure?.artifactPath, cwd),
    reports: record.reports ? Object.fromEntries(Object.entries(record.reports.paths).map(([kind, file]) => [kind, displayPath(file, cwd)])) : undefined,
    durationMs: record.durationMs,
    error: record.error ? errorMessage(record.error) : undefined,
  };
}

export function buildSummary(records, { strict = false, cwd = process.cwd() } = {}) {
  const exitCode = exitCodeFor(records, { strict });
  const totals = { pass: 0, fail: 0, incomplete: 0, error: 0, resolved: 0, reproduced: 0 };
  for (const record of records) totals[record.status] += 1;
  return { schema: "cloudfault.ci", version: 1, status: VERDICT[exitCode], exitCode, strict, totals, results: records.map((record) => summarizeRecord(record, cwd)) };
}

const ICONS = { pass: "✅", resolved: "✅", fail: "❌", reproduced: "❌", incomplete: "⚠️", error: "💥" };

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function code(values) {
  return values.map((value) => `\`${cell(value)}\``).join(", ");
}

function searchDetail(result) {
  if (result.status === "error") return cell(result.error);
  const parts = [];
  if (result.baselineFailed) parts.push("baseline fails with no faults injected");
  else if (result.minimalFailureSet?.length) parts.push(`MFS: ${code(result.minimalFailureSet)}`);
  if (result.failedCheckers?.length) parts.push(`checks: ${code(result.failedCheckers)}`);
  const budgeted = Object.entries(result.skipped ?? {}).filter(([reason]) => reason !== "failure-stop");
  if (budgeted.length) parts.push(`skipped by budget: ${budgeted.map(([reason, count]) => `${reason}=${count}`).join(", ")}`);
  if (result.artifact) parts.push(`artifact \`${cell(result.artifact)}\``);
  return parts.join(" · ");
}

/** Markdown for `$GITHUB_STEP_SUMMARY` (and `summary.md`). */
export function renderSummaryMarkdown(summary) {
  const searches = summary.results.filter((result) => result.kind === "search");
  const pins = summary.results.filter((result) => result.kind === "pin");
  const lines = [`## CloudFault — ${summary.status.toUpperCase()}`, ""];
  const counts = Object.entries(summary.totals).filter(([, count]) => count).map(([status, count]) => `${count} ${status}`);
  lines.push(counts.length ? counts.join(" · ") : "Nothing ran.", "");
  if (pins.length) {
    lines.push("### Pinned regressions", "", "| | Regression | Result | Detail |", "|---|---|---|---|");
    for (const pin of pins) {
      const detail = pin.status === "error" ? cell(pin.error) : [pin.minimalFailureSet.length ? `MFS: ${code(pin.minimalFailureSet)}` : "", pin.failedCheckers.length ? `checks: ${code(pin.failedCheckers)}` : ""].filter(Boolean).join(" · ");
      lines.push(`| ${ICONS[pin.status]} | ${cell(pin.name)} | ${pin.status} | ${detail} |`);
    }
    lines.push("");
  }
  if (searches.length) {
    lines.push("### Searches", "", "| | Suite | Result | Scenarios | Detail |", "|---|---|---|---|---|");
    for (const search of searches) {
      const scenarios = search.plannedScenarios === undefined ? "" : `${search.executedScenarios}/${search.plannedScenarios}`;
      lines.push(`| ${ICONS[search.status]} | ${cell(search.name)} | ${search.status} | ${scenarios} | ${searchDetail(search)} |`);
    }
    lines.push("");
  }
  const failures = searches.filter((search) => search.artifact);
  if (failures.length) {
    lines.push("Reproduce locally with `cloudfault replay <artifact>`; keep a fixed bug fixed with `cloudfault pin <artifact>`.", "");
  }
  return `${lines.join("\n")}\n`;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]);
}

function stripDeclaration(xml) {
  return xml.replace(/^<\?xml[^>]*\?>\s*/, "").trimEnd();
}

/** One `<testsuites>` document: each search's suite, error suites, and the regression corpus. */
export function combinedJunit(records) {
  const suites = [];
  let tests = 0;
  let failures = 0;
  let errors = 0;
  for (const record of records.filter((item) => item.kind === "search")) {
    if (record.status === "error") {
      tests += 1;
      errors += 1;
      suites.push(`<testsuite name="${escapeXml(record.name)}" tests="1" failures="0" errors="1">\n    <testcase name="load-and-run" classname="${escapeXml(record.name)}">\n      <error message="${escapeXml(errorMessage(record.error))}"/>\n    </testcase>\n</testsuite>`);
      continue;
    }
    const xml = record.reports?.junit;
    if (!xml) continue;
    tests += Number(/tests="(\d+)"/.exec(xml)?.[1] ?? 0);
    failures += Number(/failures="(\d+)"/.exec(xml)?.[1] ?? 0);
    suites.push(stripDeclaration(xml));
  }
  const pins = records.filter((item) => item.kind === "pin");
  if (pins.length) {
    const cases = pins.map((pin) => {
      const attrs = `name="${escapeXml(path.basename(pin.file, ".json"))}" classname="cloudfault.regressions" time="${((pin.durationMs ?? 0) / 1000).toFixed(6)}"`;
      if (pin.status === "resolved") return `    <testcase ${attrs}/>`;
      if (pin.status === "error") return `    <testcase ${attrs}>\n      <error message="${escapeXml(errorMessage(pin.error))}"/>\n    </testcase>`;
      const failed = pin.run.checks.filter((check) => !check.valid);
      return `    <testcase ${attrs}>\n${failed.map((check) => `      <failure type="${escapeXml(check.checker)}" message="${escapeXml(check.message ?? "pinned regression reproduced")}"/>`).join("\n")}\n    </testcase>`;
    });
    const pinFailures = pins.filter((pin) => pin.status === "reproduced").length;
    const pinErrors = pins.filter((pin) => pin.status === "error").length;
    tests += pins.length;
    failures += pinFailures;
    errors += pinErrors;
    suites.push(`<testsuite name="cloudfault/regressions" tests="${pins.length}" failures="${pinFailures}" errors="${pinErrors}">\n${cases.join("\n")}\n</testsuite>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="cloudfault" tests="${tests}" failures="${failures}" errors="${errors}">\n${suites.join("\n")}\n</testsuites>\n`;
}

function printRecord(record) {
  const name = paint("bold", record.name);
  if (record.kind === "pin") {
    const verdict = record.status === "resolved" ? pass("RESOLVED") : record.status === "reproduced" ? fail("REPRODUCED") : fail("ERROR");
    console.log(`${verdict} ${label("pinned")} ${name}${record.error ? ` — ${errorMessage(record.error)}` : ""}`);
    return;
  }
  if (record.status === "error") {
    console.log(`${fail("ERROR")} ${name} — ${errorMessage(record.error)}`);
    return;
  }
  const verdict = { pass: pass("PASS"), fail: fail("FAIL"), incomplete: warn("INCOMPLETE") }[record.status];
  const counts = `${record.result.runs.length}/${record.plan.scenarios.length} scenarios`;
  const seed = record.config.seed === undefined ? "" : `, seed ${record.config.seed}`;
  console.log(`${verdict} ${name} ${label(`(${record.plan.strategy}, ${counts}${seed})`)}`);
  if (record.status === "fail") {
    const ids = record.outcome.minimalFailureSet?.map((item) => item.id) ?? [];
    console.log(`  ${label("minimal failure set:")} ${record.outcome.baselineFailed ? "(baseline — no faults needed)" : ids.join(" + ") || "(unminimized)"}`);
    console.log(`  ${label("artifact:")} ${filePath(displayPath(record.failure.artifactPath))}`);
  }
  if (record.outcome.unexplored) console.log(`  ${label("skipped by budget:")} ${record.outcome.unexplored}`);
}

async function annotatePins(records) {
  if (!process.env.GITHUB_ACTIONS) return;
  const { githubAnnotations } = await core();
  for (const record of records) {
    if (record.status === "reproduced") for (const annotation of githubAnnotations(record.run)) console.log(annotation);
    if (record.status === "error") console.log(`::error title=CloudFault pinned regression::${encodeURIComponent(`${path.basename(record.file)}: ${errorMessage(record.error)}`)}`);
  }
}

export const CI_USAGE = `cloudfault ci [config|directory|glob ...] [options]

Runs every config (default: cloudfault.config.{mjs,js} under the working
directory), after replaying the pinned regression corpus, and writes
summary.json, summary.md, and junit.xml to the reports directory.

Options:
  --seed <n>             Seed every search (printed so failures reproduce)
  --max-scenarios <n>    Cap planned scenarios per config
  --max-runs <n>         Run budget per config
  --time-budget <dur>    Wall-time budget per config (90s, 5m, 1h)
  --concurrency <n>      Scenarios run in parallel per config
  --reports-dir <dir>    Reports directory (default ${DEFAULT_REPORT_DIRECTORY})
  --failures-dir <dir>   Failure artifact directory (default .cloudfault/failures)
  --regressions-dir <d>  Pinned regression corpus (default ${DEFAULT_REGRESSION_DIRECTORY})
  --no-regressions       Skip replaying the regression corpus
  --strict               Exit 2 when a budget left scenarios unexplored

Exit codes: 0 pass · 1 invariant failure or reproduced regression ·
            2 incomplete (with --strict) · 3 config or tool error`;

export async function ciCommand(args, { cwd = process.cwd() } = {}) {
  const { flags, positional } = parseFlags(args, { booleans: ["strict", "no-regressions", "help"] });
  if (flags.help) { console.log(CI_USAGE); return EXIT.pass; }
  const overrides = configOverrides(flags);
  const reportDirectory = path.resolve(cwd, overrides.reportDirectory ?? DEFAULT_REPORT_DIRECTORY);
  overrides.reportDirectory = reportDirectory;
  const strict = flags.strict === true;
  const configs = discoverConfigs(positional, cwd);
  if (!configs.length) throw new Error(`No CloudFault configs found (looked for cloudfault.config.{mjs,js} under ${positional.length ? positional.join(", ") : displayPath(cwd) || "."})`);

  const records = [];
  if (!flags["no-regressions"]) {
    const directory = String(flags["regressions-dir"] ?? DEFAULT_REGRESSION_DIRECTORY);
    const pins = await replayPins(directory, { cwd, onResult: printRecord });
    await annotatePins(pins);
    records.push(...pins);
  }
  for (const module of configs) {
    let record;
    try {
      record = await runSuite(module, overrides);
    } catch (error) {
      record = { kind: "search", name: displayPath(module, cwd), module, status: "error", error };
    }
    printRecord(record);
    records.push(record);
  }

  const summary = buildSummary(records, { strict, cwd });
  const markdown = renderSummaryMarkdown(summary);
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(path.join(reportDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(reportDirectory, "summary.md"), markdown);
  fs.writeFileSync(path.join(reportDirectory, "junit.xml"), combinedJunit(records));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

  const verdict = { pass: pass("CloudFault CI PASS"), fail: fail("CloudFault CI FAIL"), incomplete: warn("CloudFault CI INCOMPLETE"), error: fail("CloudFault CI ERROR") }[summary.status];
  console.log(`\n${verdict} ${label(`exit ${summary.exitCode}`)}`);
  console.log(`${label("Reports:")} ${filePath(displayPath(reportDirectory, cwd) || ".")}`);
  if (summary.totals.incomplete && !strict) console.log(`${warn("WARN")} some searches stopped at their budget; pass --strict to fail on that.`);
  return summary.exitCode;
}
