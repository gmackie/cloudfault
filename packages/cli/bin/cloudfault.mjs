#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const core = () => import("@cloudfault/core");
const cloudflare = () => import("@cloudfault/cloudflare");
const adapters = () => import("@cloudfault/adapters");

function usage() {
  return `cloudfault <command>

Commands:
  run <module>          Systematically explore a cloudfault config module
  replay <artifact>     Re-run the scenario stored in a failure artifact
  timeline <artifact>   Render a saved failure history
  inspect <wrangler> [source-root]
                        Discover Cloudflare bindings and known API integrations
  adapters              List bundled unofficial semantic API adapters
  init [path]           Create a starter cloudfault.config.mjs
  demo                  Run the in-memory stale-read + ambiguous-commit demo`;
}

function safeFilePart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "failure";
}

async function importModule(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    const url = specifier.startsWith("file:") ? specifier : pathToFileURL(path.resolve(specifier)).href;
    return import(url);
  }
  return import(specifier);
}

async function loadConfig(modulePath) {
  const mod = await importModule(modulePath);
  const config = mod.cloudfault ?? mod.default;
  if (!config || typeof config !== "object") throw new Error(`No 'cloudfault' or default config export found in ${modulePath}`);
  if (!Array.isArray(config.faultPoints)) throw new Error("CloudFault config must expose faultPoints[]");
  if (typeof config.execute !== "function") throw new Error("CloudFault config must expose execute(scenario)");
  return config;
}

async function runConfig(modulePath) {
  const { createFailureArtifact, exploreScenarios, renderFailureArtifact, renderChecks } = await core();
  const config = await loadConfig(modulePath);
  const result = await exploreScenarios(config.faultPoints, config.execute, {
    maxDepth: config.maxDepth ?? 1,
    maxScenarios: config.maxScenarios,
    seed: config.seed,
    stopOnFirstFailure: config.stopOnFirstFailure ?? true,
    minimizeFailure: config.minimizeFailure ?? true,
  });

  if (!result.firstFailure) {
    console.log(`CloudFault PASS — ${config.name ?? modulePath}`);
    console.log(`Scenarios executed: ${result.runs.length + 1}`);
    if (result.baseline) console.log(renderChecks(result.baseline.checks));
    return;
  }

  const artifact = createFailureArtifact({
    testName: config.name ?? modulePath,
    run: result.firstFailure,
    minimalFailureSet: result.minimalFailureSet,
    replay: config.replay ?? { module: modulePath, exportName: "runScenario", testName: config.name },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    metadata: {
      minimizationAttempts: result.minimizationAttempts,
      exploredRuns: result.runs.length,
    },
  });

  const directory = path.resolve(config.failureDirectory ?? ".cloudfault/failures");
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = path.join(directory, `${stamp}-${safeFilePart(artifact.testName)}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");

  console.log(renderFailureArtifact(artifact));
  console.log(`\nFailure artifact: ${artifactPath}`);
  console.log(`Replay: cloudfault replay ${artifactPath}`);
  process.exitCode = 1;
}

async function replay(file) {
  const { checksFailed, parseFailureArtifact, renderChecks, renderTimeline } = await core();
  const absolute = path.resolve(file);
  const artifact = parseFailureArtifact(fs.readFileSync(absolute, "utf8"));
  if (!artifact.replay?.module) {
    console.log(renderTimeline(artifact.history));
    throw new Error("Artifact has no replay.module; timeline rendered but execution cannot be repeated");
  }

  const modulePath = artifact.replay.module;
  const mod = await importModule(modulePath);
  const exportName = artifact.replay.exportName ?? "runScenario";
  const execute = mod[exportName];
  if (typeof execute !== "function") throw new Error(`Replay module ${modulePath} does not export ${exportName}()`);

  const perturbations = artifact.minimalFailureSet ?? artifact.scenario.perturbations;
  const scenario = {
    ...artifact.scenario,
    id: perturbations.length ? perturbations.map((item) => item.id).join("+") : "baseline",
    perturbations,
  };
  const result = await execute(scenario, artifact.replay.args);
  console.log(`CloudFault replay — ${artifact.testName}\n`);
  console.log(renderChecks(result.checks));
  console.log("\nTimeline:");
  console.log(renderTimeline(result.history));
  if (checksFailed(result.checks)) {
    console.log("\nREPRODUCED");
    process.exitCode = 1;
  } else {
    console.log("\nNOT REPRODUCED");
    process.exitCode = 2;
  }
}

async function timeline(file) {
  const { parseFailureArtifact, renderFailureArtifact } = await core();
  const artifact = parseFailureArtifact(fs.readFileSync(path.resolve(file), "utf8"));
  console.log(renderFailureArtifact(artifact));
}

async function sourceFiles(root) {
  const extensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]);
  const ignored = new Set(["node_modules", ".git", "dist", "build", ".wrangler", ".cloudfault", "coverage"]);
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && extensions.has(path.extname(entry.name))) output.push(candidate);
    }
  };
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) visit(root);
  return output;
}

async function inspectWrangler(file, sourceRoot) {
  const { discoverWranglerTopology } = await cloudflare();
  const { detectAdaptersFromSource, mergeAdapterEvidence } = await adapters();
  const absolute = path.resolve(file);
  const topology = discoverWranglerTopology(fs.readFileSync(absolute, "utf8"));
  console.log(`CloudFault topology: ${absolute}\n`);
  if (topology.name) console.log(`Worker: ${topology.name}\n`);
  if (!topology.bindings.length) console.log("No supported Cloudflare bindings found.");
  else {
    console.log("Cloudflare bindings:");
    for (const item of topology.bindings) console.log(`  ${item.type.padEnd(18)} ${item.binding}`);
  }

  const root = path.resolve(sourceRoot ?? path.dirname(absolute));
  const findings = [];
  for (const candidate of await sourceFiles(root)) {
    let source;
    try { source = fs.readFileSync(candidate, "utf8"); } catch { continue; }
    for (const finding of detectAdaptersFromSource(source)) {
      findings.push({
        ...finding,
        evidence: finding.evidence.map((evidence) => `${path.relative(root, candidate)}:${evidence}`),
      });
    }
  }
  const detected = mergeAdapterEvidence(findings);
  console.log("\nExternal semantic adapters:");
  if (!detected.length) console.log("  (none detected from imports or API hosts)");
  for (const finding of detected) {
    console.log(`  ${finding.adapter.padEnd(18)} ${finding.provider}`);
    for (const evidence of finding.evidence.slice(0, 4)) console.log(`    - ${evidence}`);
  }
}

async function listAdapters() {
  const { firstPartyAdapters } = await adapters();
  console.log("CloudFault bundled unofficial adapters\n");
  for (const adapter of firstPartyAdapters) {
    console.log(`${adapter.manifest.name.padEnd(18)} ${adapter.manifest.provider}`);
  }
  console.log(`\n${firstPartyAdapters.length} adapters`);
}

function init(target = "cloudfault.config.mjs") {
  const absolute = path.resolve(target);
  if (fs.existsSync(absolute)) throw new Error(`${absolute} already exists`);
  const content = `import { defineCloudFault, invariant } from "@cloudfault/core";

// Import semantic/fault packs and define the application-specific invariants
// that must hold under every explored scenario.
export const cloudfault = defineCloudFault({
  name: "my-worker-correctness",
  maxDepth: 2,
  faultPoints: [],

  async execute(scenario) {
    // Start your Cloudflare test harness, configure nemesis bindings from
    // scenario.perturbations, exercise the workload, then return:
    // { scenario, history, checks, state }
    throw new Error("Implement execute(scenario)");
  },
});
`;
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  console.log(`Created ${absolute}`);
}

async function runDemo() {
  const { History, invariant, minimizeFailureSet, runCheckers, renderTimeline } = await core();
  const { EventuallyConsistentKv, staleKvRead } = await cloudflare();
  const { stripeAdapter } = await import("@cloudfault/stripe");

  const request = new Request("https://api.stripe.com/v1/payment_intents/pi_demo/confirm", { method: "POST" });
  const match = stripeAdapter.match(request);
  const ambiguous = stripeAdapter.faultSpace(match.operation).find((item) => item.kind === "commit-then-timeout");
  const stale = staleKvRead("ORDER_STATE", { region: "FRA", versionsBehind: 1 });
  const original = [stale, ambiguous];

  async function execute(active) {
    const activeIds = new Set(active.map((item) => item.id));
    const history = new History(() => 0);
    const kv = new EventuallyConsistentKv();
    kv.write("PENDING", 1);
    kv.write("PAID", 2);
    if (activeIds.has(stale.id)) kv.setObserverVersion("FRA", 1);
    else kv.converge("FRA");
    const state = { charges: 0, observed: kv.read("FRA").visibleValue };
    const checkout = { id: "checkout-2", name: "checkout", process: 2, resource: "order-812" };
    history.invoke(checkout, { observedOrderState: state.observed });
    if (state.observed !== "PAID") {
      // The first provider attempt commits. Under the ambiguous fault the caller
      // does not observe success and retries with a new idempotency context.
      state.charges++;
      if (activeIds.has(ambiguous.id)) {
        history.perturb(ambiguous, checkout);
        state.charges++;
      }
    }
    history.complete(checkout, "ok", { charges: state.charges });
    const checks = await runCheckers([
      invariant("at-most-one-new-charge", ({ state }) => state.charges <= 1, ({ state }) => `Expected at most 1 new charge, observed ${state.charges}`),
    ], { history: history.snapshot(), state });
    return { failed: checks.some((item) => !item.valid), history: history.snapshot(), checks, state };
  }

  const combined = await execute(original);
  const minimal = await minimizeFailureSet(original, async (candidate) => (await execute(candidate)).failed);
  console.log("CloudFault — systematic distributed-correctness demo\n");
  console.log("Minimal Failure Set:");
  for (const item of minimal.minimal) console.log(`  - ${item.kind}: ${item.description}`);
  console.log(`\nFinal charges: ${combined.state.charges}`);
  console.log("\nHistory:");
  console.log(renderTimeline(combined.history));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "run" && args[0]) await runConfig(args[0]);
  else if (command === "replay" && args[0]) await replay(args[0]);
  else if (command === "timeline" && args[0]) await timeline(args[0]);
  else if (command === "inspect" && args[0]) await inspectWrangler(args[0], args[1]);
  else if (command === "adapters") await listAdapters();
  else if (command === "init") init(args[0]);
  else if (command === "demo") await runDemo();
  else {
    console.log(usage());
    if (command) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
