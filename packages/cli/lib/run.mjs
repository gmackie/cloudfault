import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDuration, parseInteger } from "./flags.mjs";

const core = () => import("@cloudfault/core");

export const DEFAULT_REPORT_DIRECTORY = ".cloudfault/reports";
export const DEFAULT_FAILURE_DIRECTORY = ".cloudfault/failures";

/** A path relative to `base` when it is inside it, else absolute. */
export function displayPath(file, base = process.cwd()) {
  const relative = path.relative(base, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

export function safeFilePart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "failure";
}

/**
 * Imports a config/replay module. Anything that names an existing file (with
 * or without a leading `./`) is loaded from disk relative to the first base
 * that has it; everything else is treated as a package specifier.
 */
export async function importModule(specifier, bases = [process.cwd()]) {
  if (specifier.startsWith("file:")) return import(specifier);
  for (const base of bases) {
    const candidate = path.resolve(base, specifier);
    if (fs.existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) throw new Error(`Cannot find module file ${specifier}`);
  return import(specifier);
}

function unserializable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `[unserializable: ${message.split("\n")[0].slice(0, 160)}]`;
}

/**
 * A JSON-safe copy of `value` that never throws. Values JSON.stringify would
 * crash on — live RPC stubs poisoned by a closed test harness, throwing
 * getters, cycles, BigInts — become string placeholders instead, so a failure
 * artifact is still written when a run's state holds something exotic.
 */
export function toPlain(value, ancestors = new Set()) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  try {
    if (ancestors.has(value)) return "[circular]";
    ancestors.add(value);
    try {
      if (typeof value.toJSON === "function") return toPlain(value.toJSON(), ancestors);
      if (Array.isArray(value)) return value.map((item) => toPlain(item, ancestors) ?? null);
      const plain = {};
      for (const key of Object.keys(value)) {
        let item;
        try { item = value[key]; } catch (error) { plain[key] = unserializable(error); continue; }
        const copy = toPlain(item, ancestors);
        if (copy !== undefined) plain[key] = copy;
      }
      return plain;
    } finally {
      ancestors.delete(value);
    }
  } catch (error) {
    return unserializable(error);
  }
}

/** The serializable parts of a run made plain; the scenario is kept as-is. */
function plainRun(run) {
  if (!run) return run;
  return { ...run, state: toPlain(run.state), history: toPlain(run.history) ?? [], checks: toPlain(run.checks) ?? [] };
}

/**
 * Search knobs a CI job sets per invocation (`--seed $RUN_ID` etc.), taken
 * from parsed flags. Only flags that were given are returned.
 */
export function configOverrides(flags) {
  const overrides = {};
  if (flags.seed !== undefined) overrides.seed = parseInteger(flags.seed, "seed");
  if (flags["max-scenarios"] !== undefined) overrides.maxScenarios = parseInteger(flags["max-scenarios"], "max-scenarios");
  if (flags["max-runs"] !== undefined) overrides.maxRuns = parseInteger(flags["max-runs"], "max-runs");
  if (flags["time-budget"] !== undefined) overrides.maxWallTimeMs = parseDuration(flags["time-budget"], "time-budget");
  if (flags.concurrency !== undefined) overrides.concurrency = Math.max(1, parseInteger(flags.concurrency, "concurrency"));
  if (flags["reports-dir"] !== undefined) overrides.reportDirectory = String(flags["reports-dir"]);
  if (flags["failures-dir"] !== undefined) overrides.failureDirectory = String(flags["failures-dir"]);
  return overrides;
}

export function applyOverrides(config, overrides = {}) {
  const { maxRuns, maxWallTimeMs, ...direct } = overrides;
  const budget = { ...config.budget };
  if (maxRuns !== undefined) budget.maxRuns = maxRuns;
  if (maxWallTimeMs !== undefined) budget.maxWallTimeMs = maxWallTimeMs;
  return { ...config, ...direct, budget: Object.keys(budget).length ? budget : undefined };
}

export async function loadConfig(modulePath, overrides = {}) {
  const { assertValidCloudFaultConfig } = await core();
  const mod = await importModule(modulePath);
  const config = mod.cloudfault ?? mod.default;
  if (!config || typeof config !== "object") throw new Error(`No 'cloudfault' or default config export found in ${modulePath}`);
  if (!Array.isArray(config.faultPoints) && typeof config.resolveFaultSpace !== "function") throw new Error("CloudFault config must expose faultPoints[] or resolveFaultSpace(discoveredCall)");
  if (typeof config.execute !== "function") throw new Error("CloudFault config must expose execute(scenario)");
  if (Array.isArray(config.faultPoints)) assertValidCloudFaultConfig(config);
  return applyOverrides(config, overrides);
}

export async function materializeFaultPoints(config) {
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

export function executionOptions(config) {
  return {
    seed: config.seed,
    stopOnFirstFailure: config.stopOnFirstFailure ?? true,
    minimizeFailure: config.minimizeFailure ?? true,
    concurrency: config.concurrency ?? 1,
    budget: config.budget,
  };
}

export async function guidanceForConfig(config) {
  if (!config.persistGuidance && !config.guidanceFile) return undefined;
  const { FileCoverageGuidanceStore } = await core();
  const store = new FileCoverageGuidanceStore(config.guidanceFile);
  return { store, guidance: await store.load() };
}

export async function buildPlan(config, faultPoints, guidanceState) {
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

async function persistGuidance(guidanceState, result) {
  if (!guidanceState) return;
  if (result.baseline) guidanceState.guidance.observe(result.baseline);
  for (const run of result.runs) guidanceState.guidance.observe(run);
  await guidanceState.store.save(guidanceState.guidance);
}

/** Plain-data copy of a plan execution, safe to serialize after its harness closed. */
export function plainResult(raw, plan) {
  return { ...raw, baseline: plainRun(raw.baseline), runs: raw.runs.map(plainRun), firstFailure: plainRun(raw.firstFailure), plan };
}

export async function executeConfig(modulePath, overrides = {}) {
  const { executeScenarioPlan } = await core();
  const config = await loadConfig(modulePath, overrides);
  const faultPoints = await materializeFaultPoints(config);
  const execute = await executionForConfig(config, modulePath);
  const guidanceState = await guidanceForConfig(config);
  const plan = await buildPlan(config, faultPoints, guidanceState);
  const raw = await executeScenarioPlan(plan, execute, executionOptions(config));
  await persistGuidance(guidanceState, raw);
  return { config, plan, result: plainResult(raw, plan) };
}

/**
 * What a search means for a CI gate. A failing baseline is a failure with an
 * empty minimal failure set (no fault is needed to break it). Scenarios a
 * budget skipped make an otherwise passing search `incomplete`; scenarios
 * skipped because the search already stopped on a failure do not.
 */
export async function searchOutcome(result) {
  const { checksFailed } = await core();
  const baselineFailed = result.baseline ? checksFailed(result.baseline.checks) : false;
  const failingRun = baselineFailed ? result.baseline : result.firstFailure;
  const unexplored = result.execution.skipped.filter((item) => item.reason !== "failure-stop");
  const skipped = {};
  for (const item of result.execution.skipped) skipped[item.reason] = (skipped[item.reason] ?? 0) + 1;
  return {
    status: failingRun ? "fail" : unexplored.length ? "incomplete" : "pass",
    failingRun,
    minimalFailureSet: baselineFailed ? [] : result.minimalFailureSet,
    baselineFailed,
    unexplored: unexplored.length,
    skipped,
  };
}

function reportPaths(directory, testName) {
  const safe = safeFilePart(testName);
  return {
    json: path.join(directory, `${safe}.json`),
    junit: path.join(directory, `${safe}.junit.xml`),
    html: path.join(directory, `${safe}.html`),
  };
}

/** Writes JSON + JUnit for every search and HTML for failures; returns written paths. */
export async function writeReports(config, name, result, artifact) {
  const { dependencyCoverage, githubAnnotations, htmlFailureReport, jsonReport, junitReport } = await core();
  const directory = path.resolve(config.reportDirectory ?? DEFAULT_REPORT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const paths = reportPaths(directory, name);
  const written = {};
  const coverage = result.baseline ? dependencyCoverage(result.baseline, result.runs) : undefined;
  let junit;
  if (result.baseline) {
    junit = junitReport(name, result.baseline, result.runs);
    fs.writeFileSync(paths.json, jsonReport(result.baseline, result.runs));
    fs.writeFileSync(paths.junit, junit);
    written.json = paths.json;
    written.junit = paths.junit;
  }
  if (artifact) {
    fs.writeFileSync(paths.html, htmlFailureReport(artifact, { dependencyCoverage: coverage }));
    written.html = paths.html;
  }
  if (process.env.GITHUB_ACTIONS && artifact) for (const annotation of githubAnnotations({ checks: artifact.checks })) console.log(annotation);
  return { paths: written, coverage, junit };
}

/** A replay module reference that resolves from the working directory. */
function replayModule(modulePath) {
  const absolute = path.resolve(modulePath);
  if (!fs.existsSync(absolute)) return modulePath;
  const relative = displayPath(absolute);
  return path.isAbsolute(relative) ? relative : `./${relative.split(path.sep).join("/")}`;
}

export async function writeFailureArtifact({ config, modulePath, name, plan, result, outcome }) {
  const { createFailureArtifact } = await core();
  const artifact = toPlain(createFailureArtifact({
    testName: name,
    run: outcome.failingRun,
    minimalFailureSet: outcome.minimalFailureSet,
    replay: config.replay ?? (modulePath ? { module: replayModule(modulePath), exportName: "runScenario", testName: config.name } : undefined),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    metadata: {
      searchStrategy: plan.strategy,
      plannedScenarios: plan.scenarios.length,
      executedScenarios: result.runs.length,
      skippedScenarios: result.execution.skipped.length,
      estimatedCost: result.execution.estimatedCost,
      concurrency: result.execution.concurrency,
      minimizationAttempts: result.minimizationAttempts,
      baselineFailed: outcome.baselineFailed,
    },
  }));
  const directory = path.resolve(config.failureDirectory ?? DEFAULT_FAILURE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = path.join(directory, `${stamp}-${safeFilePart(artifact.testName)}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return { artifact, artifactPath };
}

/**
 * Runs one config end to end: search, outcome, reports, and (on failure) a
 * failure artifact. Shared by `cloudfault run` and `cloudfault ci`.
 */
export async function runSuite(modulePath, overrides = {}) {
  const started = performance.now();
  const { config, plan, result } = await executeConfig(modulePath, overrides);
  return finishSuite({ config, modulePath, name: config.name ?? displayPath(path.resolve(modulePath)), plan, result, started });
}

/** Outcome, failure artifact, and reports for an executed search. */
export async function finishSuite({ config, modulePath, name, plan, result, started, extra = {} }) {
  const outcome = await searchOutcome(result);
  const failure = outcome.failingRun ? await writeFailureArtifact({ config, modulePath, name, plan, result, outcome }) : undefined;
  const reports = await writeReports(config, name, result, failure?.artifact);
  return { kind: "search", name, module: modulePath, config, plan, result, outcome, status: outcome.status, failure, reports, durationMs: performance.now() - started, ...extra };
}
