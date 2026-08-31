#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { doctorProject, initProject, sourceFiles } from "../lib/project.mjs";

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
                        Discover bindings, integrations, and recommended tests
  doctor [path]         Validate runtime dependencies and semantic coverage
  recommend [path]      Print semantics-grounded scenario/invariant suggestions
  adapters              List bundled unofficial semantic API adapters
  init [path]           Generate a project-aware starter config + recommendations
  demo                  Run the stale-read + ambiguous-commit demo`;
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
  if (!Array.isArray(config.faultPoints) && typeof config.resolveFaultSpace !== "function") {
    throw new Error("CloudFault config must expose faultPoints[] or resolveFaultSpace(discoveredCall)");
  }
  if (typeof config.execute !== "function") throw new Error("CloudFault config must expose execute(scenario)");
  return config;
}

async function faultPointsForConfig(config) {
  if (Array.isArray(config.faultPoints) && config.faultPoints.length) return config.faultPoints;
  const { faultPointsFromHistory } = await core();
  const baseline = await config.execute({ id: "baseline-discovery", perturbations: [], seed: config.seed });
  return faultPointsFromHistory(baseline.history, config.resolveFaultSpace);
}

function reportPaths(directory, testName) {
  const safe = safeFilePart(testName);
  return {
    json: path.join(directory, `${safe}.json`),
    junit: path.join(directory, `${safe}.junit.xml`),
    html: path.join(directory, `${safe}.html`),
  };
}

async function writeRunReports(config, result, artifact) {
  const {
    dependencyCoverage,
    githubAnnotations,
    htmlFailureReport,
    jsonReport,
    junitReport,
  } = await core();
  const directory = path.resolve(config.reportDirectory ?? ".cloudfault/reports");
  fs.mkdirSync(directory, { recursive: true });
  const paths = reportPaths(directory, config.name ?? "cloudfault");
  const coverage = result.baseline ? dependencyCoverage(result.baseline, result.runs) : undefined;
  if (result.baseline) {
    fs.writeFileSync(paths.json, jsonReport(result.baseline, result.runs));
    fs.writeFileSync(paths.junit, junitReport(config.name ?? "cloudfault", result.baseline, result.runs));
  }
  if (artifact) fs.writeFileSync(paths.html, htmlFailureReport(artifact, { dependencyCoverage: coverage }));
  if (process.env.GITHUB_ACTIONS && result.firstFailure) {
    for (const annotation of githubAnnotations(result.firstFailure)) console.log(annotation);
  }
  return { paths, coverage };
}

async function runConfig(modulePath) {
  const {
    FileScenarioCache,
    createFailureArtifact,
    exploreScenarios,
    renderChecks,
    renderFailureArtifact,
    withScenarioCache,
  } = await core();
  const config = await loadConfig(modulePath);
  const faultPoints = await faultPointsForConfig(config);
  let execute = config.execute;
  if (config.cache === true || config.cache === "file") {
    execute = withScenarioCache(execute, {
      cache: new FileScenarioCache(config.cacheFile),
      testName: config.name ?? modulePath,
      workloadFingerprint: config.workloadFingerprint,
      environmentFingerprint: config.environmentFingerprint,
    });
  }
  const result = await exploreScenarios(faultPoints, execute, {
    maxDepth: config.maxDepth ?? 1,
    maxScenarios: config.maxScenarios,
    seed: config.seed,
    stopOnFirstFailure: config.stopOnFirstFailure ?? true,
    minimizeFailure: config.minimizeFailure ?? true,
  });

  if (!result.firstFailure) {
    const reports = await writeRunReports(config, result);
    console.log(`CloudFault PASS — ${config.name ?? modulePath}`);
    console.log(`Scenarios executed: ${result.runs.length + 1}`);
    if (result.baseline) console.log(renderChecks(result.baseline.checks));
    if (reports.coverage) console.log(`Dependency coverage: ${reports.coverage.exercised}/${reports.coverage.discovered} (${(reports.coverage.ratio * 100).toFixed(1)}%)`);
    return;
  }

  const artifact = createFailureArtifact({
    testName: config.name ?? modulePath,
    run: result.firstFailure,
    minimalFailureSet: result.minimalFailureSet,
    replay: config.replay ?? { module: modulePath, exportName: "runScenario", testName: config.name },
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    metadata: { minimizationAttempts: result.minimizationAttempts, exploredRuns: result.runs.length },
  });

  const failureDirectory = path.resolve(config.failureDirectory ?? ".cloudfault/failures");
  fs.mkdirSync(failureDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = path.join(failureDirectory, `${stamp}-${safeFilePart(artifact.testName)}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
  const reports = await writeRunReports(config, result, artifact);

  console.log(renderFailureArtifact(artifact));
  if (reports.coverage) console.log(`\nDependency coverage: ${reports.coverage.exercised}/${reports.coverage.discovered} (${(reports.coverage.ratio * 100).toFixed(1)}%)`);
  console.log(`\nFailure artifact: ${artifactPath}`);
  console.log(`HTML report: ${reports.paths.html}`);
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
  const scenario = { ...artifact.scenario, id: perturbations.length ? perturbations.map((item) => item.id).join("+") : "baseline", perturbations };
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

async function inspectWrangler(file, sourceRoot) {
  const { discoverWranglerTopology } = await cloudflare();
  const { detectAdaptersFromSource, mergeAdapterEvidence, recommendCloudFaultCoverage, recommendationMarkdown } = await adapters();
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
  for (const candidate of sourceFiles(root)) {
    let source;
    try { source = fs.readFileSync(candidate, "utf8"); } catch { continue; }
    for (const finding of detectAdaptersFromSource(source)) {
      findings.push({ ...finding, evidence: finding.evidence.map((evidence) => `${path.relative(root, candidate)}:${evidence}`) });
    }
  }
  const detected = mergeAdapterEvidence(findings);
  console.log("\nExternal semantic adapters:");
  if (!detected.length) console.log("  (none detected from imports or API hosts)");
  for (const finding of detected) {
    console.log(`  ${finding.adapter.padEnd(18)} ${finding.provider}`);
    for (const evidence of finding.evidence.slice(0, 4)) console.log(`    - ${evidence}`);
  }
  const recommendations = recommendCloudFaultCoverage(topology.bindings, detected);
  console.log("\nRecommended correctness coverage:\n");
  console.log(recommendationMarkdown(recommendations));
}

async function listAdapters() {
  const { firstPartyAdapters } = await adapters();
  console.log("CloudFault bundled unofficial adapters\n");
  for (const adapter of firstPartyAdapters) console.log(`${adapter.manifest.name.padEnd(18)} ${adapter.manifest.provider}`);
  console.log(`\n${firstPartyAdapters.length} adapters`);
}

function doctor(target) {
  const report = doctorProject(target ?? process.cwd());
  console.log(`CloudFault doctor — ${report.project.root}\n`);
  for (const check of report.checks) console.log(`${check.valid ? "PASS" : "WARN"} ${check.name.padEnd(28)} ${check.detail}`);
  console.log(`\nBindings: ${report.project.topology?.bindings.length ?? 0}`);
  console.log(`Detected adapters: ${report.project.adapters.map((item) => item.adapter).join(", ") || "none"}`);
  console.log(`Recommendations: ${report.project.recommendations.length}`);
  if (report.unsupportedBindings.length) {
    console.log("\nBindings without dedicated semantic packs:");
    for (const item of report.unsupportedBindings) console.log(`  ${item.type.padEnd(18)} ${item.binding}`);
  }
  if (!report.valid) process.exitCode = 1;
}

function recommend(target) {
  const { project } = doctorProject(target ?? process.cwd());
  return adapters().then(({ recommendationMarkdown }) => console.log(recommendationMarkdown(project.recommendations)));
}

function init(target) {
  const result = initProject(target ?? process.cwd());
  console.log(`Created ${result.configPath}`);
  console.log(`Created ${result.recommendationPath}`);
  console.log(`Detected ${result.project.topology?.bindings.length ?? 0} Cloudflare bindings and ${result.project.adapters.length} external adapters.`);
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
    kv.write("PENDING", 1); kv.write("PAID", 2);
    if (activeIds.has(stale.id)) kv.setObserverVersion("FRA", 1); else kv.converge("FRA");
    const state = { charges: 0, observed: kv.read("FRA").visibleValue };
    const checkout = { id: "checkout-2", name: "checkout", process: 2, resource: "order-812" };
    history.invoke(checkout, { observedOrderState: state.observed });
    if (state.observed !== "PAID") {
      state.charges++;
      if (activeIds.has(ambiguous.id)) { history.perturb(ambiguous, checkout); state.charges++; }
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
  else if (command === "doctor") doctor(args[0]);
  else if (command === "recommend") await recommend(args[0]);
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
