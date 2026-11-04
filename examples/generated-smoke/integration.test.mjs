import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectProject, generateStarterConfig } from "../../packages/cli/lib/project.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cli = path.join(root, "packages/cli/bin/cloudfault-v4.mjs");

/**
 * Copy the fixture Worker inside the repository (so the generated config's
 * "@gmacko/cloudfault" imports resolve), generate its config exactly as
 * `cloudfault init` would, and optionally rewrite the smoke requests.
 */
function generated(name, requests) {
  const directory = path.join(here, ".work", name);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.cpSync(path.join(here, "worker"), directory, { recursive: true });
  let config = generateStarterConfig(detectProject(directory));
  if (requests) config = config.replace('requests: [{ path: "/" }]', `requests: ${JSON.stringify(requests)}`);
  const configPath = path.join(directory, "cloudfault.config.mjs");
  fs.writeFileSync(configPath, config);
  return { directory, configPath };
}

function run(configPath, directory) {
  return spawnSync(process.execPath, [cli, "run", configPath], { cwd: directory, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 240_000 });
}

test("a generated config executes for real and fails on the Worker's read-your-writes bug", { timeout: 300_000 }, () => {
  const { directory, configPath } = generated("fragile");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /createSmokeExecute/);
  assert.doesNotMatch(config, /Implement execute/);

  const result = run(configPath, directory);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /no-unexpected-responses/);
  // KV staleness alone breaks the read-back, so it reduces to a one-perturbation set.
  const minimal = output.split("Minimal Failure Set:")[1]?.split("Timeline:")[0] ?? "";
  assert.equal(minimal.trim().split("\n").length, 1, output);
  assert.match(minimal, /SESSIONS:stale/, output);
  const failures = fs.readdirSync(path.join(directory, ".cloudfault", "failures"));
  assert.equal(failures.length, 1);
});

test("the same Worker with tolerant handling passes every applicable scenario", { timeout: 300_000 }, () => {
  const { directory, configPath } = generated("tolerant", [{ path: "/?tolerant=1" }]);
  const plan = execFileSync(process.execPath, [cli, "plan", configPath], { cwd: directory, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const scenarios = Number(plan.match(/Scenarios: (\d+)/)?.[1]);
  assert.ok(scenarios > 0, plan);

  const result = run(configPath, directory);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /CloudFault PASS/);
  assert.match(output, new RegExp(`Executed scenarios: ${scenarios}`));
});

test("an executed baseline becomes terminal evidence whose counts cover the whole starter plan", { timeout: 300_000 }, async () => {
  const { repositoryDrafts } = await import("../../packages/cli/lib/forgegraph.mjs");
  const directory = path.join(here, ".work", "evidence");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.cpSync(path.join(here, "worker"), directory, { recursive: true });

  const planned = await repositoryDrafts(directory);
  assert.equal(planned.baselineDraft.status, "queued");

  const { baselineDraft, execution } = await repositoryDrafts(directory, { execute: true });
  assert.equal(baselineDraft.status, "failed", baselineDraft.coverageSummary);
  assert.ok(baselineDraft.failedTests > 0);
  assert.equal(baselineDraft.totalTests, execution.planned, "executed + skipped = baseline + every planned scenario");
  assert.equal(baselineDraft.passedTests + baselineDraft.failedTests, execution.runs.length);
  assert.deepEqual(execution.notRunnable, []);
});

test("a Worker that cannot start is reported as not runnable, not as failed", { timeout: 300_000 }, async () => {
  const { repositoryDrafts } = await import("../../packages/cli/lib/forgegraph.mjs");
  const directory = path.join(here, ".work", "unbuilt");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.cpSync(path.join(here, "worker"), directory, { recursive: true });
  // Like an OpenNext app before `opennext build`: main points at output that does not exist yet.
  const config = path.join(directory, "wrangler.jsonc");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace('"src/index.js"', '".open-next/worker.js"'));

  const { baselineDraft, execution } = await repositoryDrafts(directory, { execute: true });
  assert.equal(baselineDraft.status, "queued");
  assert.equal(execution.runs.length, 0);
  assert.match(baselineDraft.coverageSummary, /no Worker could be started; not runnable: wrangler.jsonc/);
});

test("cloudfault ci gates a generated config and replays its pinned failure through execute()", { timeout: 600_000 }, () => {
  const { directory } = generated("ci-gate");
  const env = { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" };
  const ci = (...args) => spawnSync(process.execPath, [cli, "ci", ...args], { cwd: directory, encoding: "utf8", env, timeout: 300_000 });

  const found = ci("--no-regressions");
  assert.equal(found.status, 1, `${found.stdout}\n${found.stderr}`);
  const summary = JSON.parse(fs.readFileSync(path.join(directory, ".cloudfault/reports/summary.json"), "utf8"));
  assert.equal(summary.results[0].status, "fail");
  assert.deepEqual(summary.results[0].minimalFailureSet.length, 1);

  // Generated configs export no runScenario, so the pin replays through config.execute().
  execFileSync(process.execPath, [cli, "pin", summary.results[0].artifact], { cwd: directory, env });
  const replayed = ci("--max-scenarios", "0");
  const output = `${replayed.stdout}\n${replayed.stderr}`;
  assert.equal(replayed.status, 1, output);
  assert.match(output, /REPRODUCED pinned/);
  assert.match(output, /PASS .*0\/0 scenarios/);
});

test("ci --starter runs the starter plan for a Worker with no config and finds its bug", { timeout: 600_000 }, () => {
  const directory = path.join(here, ".work", "starter");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.cpSync(path.join(here, "worker"), directory, { recursive: true });
  const env = { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" };
  const result = spawnSync(process.execPath, [cli, "ci", "--starter"], { cwd: directory, encoding: "utf8", env, timeout: 300_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /FAIL starter:cloudfault-generated-smoke/);
  const summary = JSON.parse(fs.readFileSync(path.join(directory, ".cloudfault/reports/summary.json"), "utf8"));
  const [suite] = summary.results;
  assert.equal(suite.starter, true);
  assert.equal(suite.wrangler, "wrangler.jsonc");
  assert.deepEqual(suite.minimalFailureSet.length, 1);
  assert.ok(suite.artifact, "a failure artifact is written even without a replay module");
});

test("ci --starter reports a Worker that cannot start as not-runnable and exits 0", { timeout: 300_000 }, () => {
  const directory = path.join(here, ".work", "starter-unbuilt");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.cpSync(path.join(here, "worker"), directory, { recursive: true });
  const config = path.join(directory, "wrangler.jsonc");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace('"src/index.js"', '".open-next/worker.js"'));
  const env = { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" };
  const result = spawnSync(process.execPath, [cli, "ci", "--starter", "--strict"], { cwd: directory, encoding: "utf8", env, timeout: 240_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /NOT RUNNABLE starter:cloudfault-generated-smoke/);
  const summary = JSON.parse(fs.readFileSync(path.join(directory, ".cloudfault/reports/summary.json"), "utf8"));
  assert.equal(summary.totals["not-runnable"], 1);
  assert.match(fs.readFileSync(path.join(directory, ".cloudfault/reports/junit.xml"), "utf8"), /<skipped message="not runnable: /);
});
