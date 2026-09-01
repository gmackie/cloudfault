#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const core = () => import("@cloudfault/core");

function safeFilePart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "failure";
}

async function importModule(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    return import(specifier.startsWith("file:") ? specifier : pathToFileURL(path.resolve(specifier)).href);
  }
  return import(specifier);
}

async function loadConfig(modulePath) {
  const { assertValidCloudFaultConfig } = await core();
  const mod = await importModule(modulePath);
  const config = mod.cloudfault ?? mod.default;
  if (!config || typeof config !== "object") throw new Error(`No 'cloudfault' or default config export found in ${modulePath}`);
  if (!Array.isArray(config.faultPoints) && typeof config.resolveFaultSpace !== "function") throw new Error("CloudFault config must expose faultPoints[] or resolveFaultSpace(discoveredCall)");
  if (typeof config.execute !== "function") throw new Error("CloudFault config must expose execute(scenario)");
  if (Array.isArray(config.faultPoints)) assertValidCloudFaultConfig(config);
  return config;
}

async function materializeFaultPoints(config) {
  if (Array.isArray(config.faultPoints) && config.faultPoints.length) return config.faultPoints;
  if (typeof config.resolveFaultSpace !== "function") return [];
  const { faultPointsFromHistory } = await core();
  const baseline = await config.execute({ id: "baseline-discovery", perturbations: [], seed: config.seed });
  return faultPointsFromHistory(baseline.history, config.resolveFaultSpace);
}

async function executionForConfig(config, modulePath) {
  const { FileScenarioCache, withScenarioCache } = await core();
  let execute = config.execute;
  if (config.cache === true || config.cache === "file") {
    execute = withScenarioCache(execute, {
      cache: new FileScenarioCache(config.cacheFile),
      testName: config.name ?? modulePath,
      workloadFingerprint: config.workloadFingerprint,
      environmentFingerprint: config.environmentFingerprint,
    });
  }
  return execute;
}

function plannerOptions(config) {
  return {
    strategy: config.strategy ?? "exhaustive",
    maxDepth: config.maxDepth ?? 1,
    maxScenarios: config.maxScenarios,
    seed: config.seed,
    incidents: config.incidents,
    previousRuns: config.previousRuns,
    guided: config.guided,
    coverageGuided: config.coverageGuided,
  };
}

function executionOptions(config) {
  return {
    seed: config.seed,
    stopOnFirstFailure: config.stopOnFirstFailure ?? true,
    minimizeFailure: config.minimizeFailure ?? true,
    concurrency: config.concurrency ?? 1,
    budget: config.budget,
  };
}

async function guidanceForConfig(config) {
  if (!config.persistGuidance && !config.guidanceFile) return undefined;
  const { FileCoverageGuidanceStore } = await core();
  const store = new FileCoverageGuidanceStore(config.guidanceFile);
  return { store, guidance: await store.load() };
}

async function buildPlan(config, faultPoints, guidanceState) {
  const { coverageGuidedScenarios, planScenarios } = await core();
  const options = plannerOptions(config);
  const normal = planScenarios(faultPoints, options);
  if (normal.strategy !== "coverage-guided" || !guidanceState) return normal;
  const scenarios = coverageGuidedScenarios(faultPoints, guidanceState.guidance, {
    maxDepth: config.coverageGuided?.maxDepth ?? config.maxDepth ?? 3,
    maxCandidates: config.coverageGuided?.maxCandidates,
    maxScenarios: config.coverageGuided?.maxScenarios ?? config.maxScenarios,
    seed: config.seed,
    includePreviouslyExecuted: config.coverageGuided?.includePreviouslyExecuted,
  });
  return { ...normal, scenarios, metadata: { ...normal.metadata, persistedGuidance: true } };
}

function reportPaths(directory, testName) {
  const safe = safeFilePart(testName);
  return {
    json: path.join(directory, `${safe}.json`),
    junit: path.join(directory, `${safe}.junit.xml`),
    html: path.join(directory, `${safe}.html`),
  };
}

async function writeReports(config, result, artifact) {
  const { dependencyCoverage, githubAnnotations, htmlFailureReport, jsonReport, junitReport } = await core();
  const directory = path.resolve(config.reportDirectory ?? ".cloudfault/reports");
  fs.mkdirSync(directory, { recursive: true });
  const paths = reportPaths(directory, config.name ?? "cloudfault");
  const coverage = result.baseline ? dependencyCoverage(result.baseline, result.runs) : undefined;
  if (result.baseline) {
    fs.writeFileSync(paths.json, jsonReport(result.baseline, result.runs));
    fs.writeFileSync(paths.junit, junitReport(config.name ?? "cloudfault", result.baseline, result.runs));
  }
  if (artifact) fs.writeFileSync(paths.html, htmlFailureReport(artifact, { dependencyCoverage: coverage }));
  if (process.env.GITHUB_ACTIONS && result.firstFailure) for (const annotation of githubAnnotations(result.firstFailure)) console.log(annotation);
  return { paths, coverage };
}

async function persistGuidance(guidanceState, result) {
  if (!guidanceState) return;
  if (result.baseline) guidanceState.guidance.observe(result.baseline);
  for (const run of result.runs) guidanceState.guidance.observe(run);
  await guidanceState.store.save(guidanceState.guidance);
}

async function runModern(modulePath) {
  const { createFailureArtifact, executeScenarioPlan, renderChecks, renderFailureArtifact } = await core();
  const config = await loadConfig(modulePath);
  const faultPoints = await materializeFaultPoints(config);
  const execute = await executionForConfig(config, modulePath);
  const guidanceState = await guidanceForConfig(config);
  const plan = await buildPlan(config, faultPoints, guidanceState);
  const result = await executeScenarioPlan(plan, execute, executionOptions(config));
  result.plan = plan;
  await persistGuidance(guidanceState, result);

  console.log(`Search strategy: ${plan.strategy}`);
  console.log(`Planned scenarios: ${plan.scenarios.length}`);
  console.log(`Executed scenarios: ${result.runs.length}`);
  console.log(`Concurrency: ${result.execution.concurrency}`);
  console.log(`Estimated cost: ${result.execution.estimatedCost.toFixed(2)}`);
  if (result.execution.skipped.length) {
    const counts = Object.groupBy(result.execution.skipped, (item) => item.reason);
    console.log(`Budget/stopped scenarios: ${result.execution.skipped.length} (${Object.entries(counts).map(([reason, items]) => `${reason}=${items?.length ?? 0}`).join(", ")})`);
  }

  if (!result.firstFailure) {
    const reports = await writeReports(config, result);
    console.log(`CloudFault PASS — ${config.name ?? modulePath}`);
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
    metadata: {
      searchStrategy: plan.strategy,
      plannedScenarios: plan.scenarios.length,
      executedScenarios: result.runs.length,
      skippedScenarios: result.execution.skipped.length,
      estimatedCost: result.execution.estimatedCost,
      concurrency: result.execution.concurrency,
      minimizationAttempts: result.minimizationAttempts,
    },
  });
  const failureDirectory = path.resolve(config.failureDirectory ?? ".cloudfault/failures");
  fs.mkdirSync(failureDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = path.join(failureDirectory, `${stamp}-${safeFilePart(artifact.testName)}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const reports = await writeReports(config, result, artifact);
  console.log(renderFailureArtifact(artifact));
  console.log(`\nFailure artifact: ${artifactPath}`);
  console.log(`HTML report: ${reports.paths.html}`);
  console.log(`Replay: cloudfault replay ${artifactPath}`);
  process.exitCode = 1;
}

async function planModern(modulePath) {
  const { defaultScenarioCost } = await core();
  const config = await loadConfig(modulePath);
  const faultPoints = await materializeFaultPoints(config);
  const guidanceState = await guidanceForConfig(config);
  const plan = await buildPlan(config, faultPoints, guidanceState);
  const costs = plan.scenarios.map(defaultScenarioCost);
  console.log(`CloudFault plan — ${config.name ?? modulePath}`);
  console.log(`Strategy: ${plan.strategy}`);
  console.log(`Fault points: ${plan.metadata.faultPoints}`);
  console.log(`Perturbations: ${plan.metadata.perturbations}`);
  console.log(`Scenarios: ${plan.scenarios.length}`);
  console.log(`Concurrency: ${config.concurrency ?? 1}`);
  console.log(`Estimated total cost: ${costs.reduce((sum, value) => sum + value, 0).toFixed(2)}`);
  if (config.budget) console.log(`Budget: ${JSON.stringify(config.budget)}`);
  console.log("");
  for (const [index, scenario] of plan.scenarios.entries()) console.log(`${String(index + 1).padStart(4)}  cost=${costs[index].toFixed(2).padStart(6)}  ${scenario.id}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "run" && args[0]) await runModern(args[0]);
  else if (command === "plan" && args[0]) await planModern(args[0]);
  else await import("./cloudfault-v3.mjs");
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
