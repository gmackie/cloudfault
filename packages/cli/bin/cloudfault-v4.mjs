#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseFlags } from "../lib/flags.mjs";
import { buildPlan, configOverrides, displayPath, executeConfig, guidanceForConfig, loadConfig, materializeFaultPoints, runSuite } from "../lib/run.mjs";
import { color, fail, filePath, heading, label, pass, paint, warn } from "../lib/terminal.mjs";

const core = () => import("@cloudfault/core");
const SEARCH_BOOLEANS = ["strict"];

/** Executes a config and maps the search to a ForgeGraph evidence draft. */
async function runDraft(modulePath) {
  const { runEvidence } = await import("@cloudfault/forgegraph");
  const { config, result } = await executeConfig(modulePath);
  return runEvidence(config.name ?? path.basename(modulePath), result.baseline, result.runs, { skipped: result.execution.skipped.length });
}

async function runModern(args) {
  const { renderChecks, renderFailureArtifact } = await core();
  const { flags, positional } = parseFlags(args, { booleans: SEARCH_BOOLEANS });
  const [modulePath] = positional;
  if (!modulePath) throw new Error("Usage: cloudfault run <module> [--seed n] [--max-scenarios n] [--max-runs n] [--time-budget 5m] [--concurrency n] [--reports-dir dir] [--failures-dir dir] [--strict]");
  const suite = await runSuite(modulePath, configOverrides(flags));
  const { config, plan, result, outcome } = suite;

  console.log(`${label("Search strategy:")} ${plan.strategy}`);
  if (config.seed !== undefined) console.log(`${label("Seed:")} ${config.seed}`);
  console.log(`${label("Planned scenarios:")} ${plan.scenarios.length}`);
  console.log(`${label("Executed scenarios:")} ${result.runs.length}`);
  console.log(`${label("Concurrency:")} ${result.execution.concurrency}`);
  console.log(`${label("Estimated cost:")} ${result.execution.estimatedCost.toFixed(2)}`);
  if (result.execution.skipped.length) {
    console.log(`Budget/stopped scenarios: ${result.execution.skipped.length} (${Object.entries(outcome.skipped).map(([reason, count]) => `${reason}=${count}`).join(", ")})`);
  }

  if (!suite.failure) {
    const verdict = outcome.status === "incomplete" ? warn("CloudFault INCOMPLETE") : pass("CloudFault PASS");
    console.log(`${verdict} — ${paint("bold", suite.name)}`);
    if (result.baseline) console.log(renderChecks(result.baseline.checks, { color }));
    if (suite.reports.coverage) console.log(`Dependency coverage: ${suite.reports.coverage.exercised}/${suite.reports.coverage.discovered} (${(suite.reports.coverage.ratio * 100).toFixed(1)}%)`);
    if (outcome.status === "incomplete" && flags.strict) process.exitCode = 2;
    return;
  }

  if (outcome.baselineFailed) console.log(`${fail("Baseline fails")} with no faults injected.`);
  console.log(renderFailureArtifact(suite.failure.artifact, { color }));
  console.log(`\n${label("Failure artifact:")} ${filePath(displayPath(suite.failure.artifactPath))}`);
  if (suite.reports.paths.html) console.log(`${label("HTML report:")} ${filePath(displayPath(suite.reports.paths.html))}`);
  console.log(`${label("Replay:")} ${paint("bold", `cloudfault replay ${displayPath(suite.failure.artifactPath)}`)}`);
  console.log(`${label("Pin as a regression:")} ${paint("bold", `cloudfault pin ${displayPath(suite.failure.artifactPath)}`)}`);
  process.exitCode = 1;
}

async function planModern(args) {
  const { defaultScenarioCost } = await core();
  const { flags, positional } = parseFlags(args);
  const [modulePath] = positional;
  const config = await loadConfig(modulePath, configOverrides(flags));
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

async function replayCommand(file) {
  const { parseFailureArtifact, renderChecks, renderTimeline } = await core();
  const { replayArtifact } = await import("../lib/regressions.mjs");
  const absolute = path.resolve(file);
  const artifact = parseFailureArtifact(fs.readFileSync(absolute, "utf8"));
  if (!artifact.replay?.module) {
    console.log(renderTimeline(artifact.history, { color }));
    throw new Error("Artifact has no replay.module; timeline rendered but execution cannot be repeated");
  }
  // Pinned artifacts store their module relative to the corpus directory.
  const { run, reproduced } = await replayArtifact(artifact, { bases: [process.cwd(), path.dirname(absolute)] });
  console.log(`${heading("CloudFault replay")} — ${paint("bold", artifact.testName)}\n`);
  console.log(renderChecks(run.checks, { color }));
  console.log(`\n${heading("Timeline:")}`);
  console.log(renderTimeline(run.history, { color }));
  if (reproduced) {
    console.log(`\n${fail("REPRODUCED")}`);
    process.exitCode = 1;
  } else {
    console.log(`\n${warn("NOT REPRODUCED")}`);
    process.exitCode = 2;
  }
}

async function pinCommand(args) {
  const { DEFAULT_REGRESSION_DIRECTORY, pinFailure } = await import("../lib/regressions.mjs");
  const { flags, positional } = parseFlags(args);
  if (!positional.length) throw new Error("Usage: cloudfault pin <failure-artifact...> [--regressions-dir dir] [--name name]");
  for (const file of positional) {
    const pinned = await pinFailure(file, { directory: flags["regressions-dir"] ?? DEFAULT_REGRESSION_DIRECTORY, name: flags.name });
    console.log(`${pass(pinned.replaced ? "Re-pinned" : "Pinned")} ${paint("bold", pinned.artifact.testName)} → ${filePath(displayPath(pinned.file))}`);
  }
  console.log(`${label("Commit the corpus;")} \`cloudfault ci\` replays it before every search.`);
}

async function ci(args) {
  const { ciCommand, EXIT } = await import("../lib/ci.mjs");
  try {
    process.exitCode = await ciCommand(args);
  } catch (error) {
    const detail = error instanceof Error ? (process.env.CLOUDFAULT_DEBUG ? error.stack : error.message) : error;
    console.error(`cloudfault ci: ${detail}`);
    process.exitCode = EXIT.error;
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "ci") await ci(args);
  else if (command === "run" && args[0]) await runModern(args);
  else if (command === "plan" && args[0]) await planModern(args);
  else if (command === "replay" && args[0]) await replayCommand(args[0]);
  else if (command === "pin") await pinCommand(args);
  else if (command === "evidence") await (await import("../lib/forgegraph.mjs")).evidenceCommand(args, { runDraft });
  else if (command === "fleet") await (await import("../lib/forgegraph.mjs")).fleetCommand(args);
  else await import("./cloudfault-v3.mjs");
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
