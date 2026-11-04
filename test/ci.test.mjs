import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSummary, combinedJunit, discoverConfigs, exitCodeFor, renderSummaryMarkdown } from "../packages/cli/lib/ci.mjs";
import { parseDuration, parseFlags } from "../packages/cli/lib/flags.mjs";
import { pinFileName } from "../packages/cli/lib/regressions.mjs";
import { applyOverrides, configOverrides, toPlain } from "../packages/cli/lib/run.mjs";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/cli/bin/cloudfault-v4.mjs");

// Self-contained configs (no imports) so they load from any temp directory.
function configSource({ name, points = ["A", "B", "C"], fails = "false", state = "{}" }) {
  return `const fault = (id) => ({ id, target: id, operation: "op", kind: "fault", phase: "before-commit", category: "provider", description: \`\${id} fails\`, actualOutcome: "not-committed", observedOutcome: "definite-failure" });
export const cloudfault = {
  name: ${JSON.stringify(name)},
  maxDepth: 2,
  faultPoints: ${JSON.stringify(points)}.map((id) => ({ id, target: id, choices: [fault(id)] })),
  async execute(scenario) {
    const active = new Set(scenario.perturbations.map((item) => item.id));
    const failed = ${fails};
    return {
      scenario,
      history: [],
      state: ${state},
      checks: [{ checker: "invariant", valid: !failed, message: failed ? "invariant broken" : undefined }],
    };
  },
};
export const runScenario = (scenario) => cloudfault.execute(scenario);
`;
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloudfault-ci-"));
}

function write(directory, file, source) {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return target;
}

function cloudfault(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", ...env } });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("boolean flags never swallow the next positional argument", () => {
  assert.deepEqual(parseFlags(["--strict", "a.mjs", "--seed", "4"], { booleans: ["strict"] }), { flags: { strict: true, seed: "4" }, positional: ["a.mjs"] });
  assert.deepEqual(parseFlags(["--strict", "a.mjs"]).positional, []);
});

test("durations accept ms/s/m/h and bare seconds", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("90"), 90_000);
  assert.equal(parseDuration("1.5m"), 90_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.throws(() => parseDuration("soon", "time-budget"), /--time-budget expects a duration/);
});

test("CLI overrides replace search knobs and merge into the config budget", () => {
  const overrides = configOverrides({ seed: "42", "max-scenarios": "10", "max-runs": "5", "time-budget": "2m", concurrency: "0" });
  assert.deepEqual(overrides, { seed: 42, maxScenarios: 10, maxRuns: 5, maxWallTimeMs: 120_000, concurrency: 1 });
  const config = applyOverrides({ name: "x", seed: 1, budget: { maxEstimatedCost: 9 } }, overrides);
  assert.equal(config.seed, 42);
  assert.deepEqual(config.budget, { maxEstimatedCost: 9, maxRuns: 5, maxWallTimeMs: 120_000 });
  assert.equal(applyOverrides({ name: "x" }, {}).budget, undefined);
  assert.throws(() => configOverrides({ seed: "-1" }), /--seed expects a non-negative integer/);
});

test("toPlain survives poisoned stubs, throwing getters, cycles, and BigInts", () => {
  const poisoned = new Proxy({}, { get() { throw new Error("Attempted to use poisoned stub.\nmore"); } });
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  const shared = { n: 1 };
  const value = {
    poisoned,
    get boom() { throw new Error("getter"); },
    cyclic,
    big: 10n,
    fn() {},
    when: new Date("2026-01-01T00:00:00Z"),
    list: [poisoned, undefined, shared, shared],
  };
  assert.throws(() => JSON.stringify(value));
  const plain = toPlain(value);
  assert.doesNotThrow(() => JSON.stringify(plain));
  assert.equal(plain.poisoned, "[unserializable: Attempted to use poisoned stub.]");
  assert.equal(plain.boom, "[unserializable: getter]");
  assert.deepEqual(plain.cyclic, { name: "loop", self: "[circular]" });
  assert.equal(plain.big, "10");
  assert.equal("fn" in plain, false);
  assert.equal(plain.when, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(plain.list.slice(1), [null, { n: 1 }, { n: 1 }], "repeated (non-cyclic) references are kept");
});

test("config discovery walks directories, honours globs, and skips dependency trees", () => {
  const root = workspace();
  write(root, "apps/a/cloudfault.config.mjs", "");
  write(root, "apps/b/cloudfault.config.js", "");
  write(root, "node_modules/pkg/cloudfault.config.mjs", "");
  write(root, "suites/custom.mjs", "");
  assert.deepEqual(discoverConfigs([], root).map((file) => path.relative(root, file)), ["apps/a/cloudfault.config.mjs", "apps/b/cloudfault.config.js"]);
  assert.deepEqual(discoverConfigs(["suites/custom.mjs", "apps"], root).map((file) => path.relative(root, file)), ["suites/custom.mjs", "apps/a/cloudfault.config.mjs", "apps/b/cloudfault.config.js"]);
  if (typeof fs.globSync === "function") assert.deepEqual(discoverConfigs(["**/cloudfault.config.*"], root).length, 2);
  assert.throws(() => discoverConfigs(["missing.mjs"], root), /No such config file or directory: missing.mjs/);
});

test("exit codes rank failures over tool errors over strict incompleteness", () => {
  const records = (...statuses) => statuses.map((status) => ({ status }));
  assert.equal(exitCodeFor(records("pass", "resolved")), 0);
  assert.equal(exitCodeFor(records("pass", "incomplete")), 0);
  assert.equal(exitCodeFor(records("pass", "incomplete"), { strict: true }), 2);
  assert.equal(exitCodeFor(records("error", "incomplete"), { strict: true }), 3);
  assert.equal(exitCodeFor(records("error", "fail")), 1);
  assert.equal(exitCodeFor(records("reproduced")), 1);
});

test("summary Markdown and combined JUnit cover searches, errors, and pins", () => {
  const failingRun = { checks: [{ checker: "at-most-once", valid: false, message: "2 charges" }] };
  const records = [
    { kind: "pin", name: "checkout", file: "/repo/cloudfault-regressions/checkout-abc.json", status: "reproduced", artifact: { minimalFailureSet: [{ id: "A" }], scenario: { perturbations: [] } }, run: failingRun, durationMs: 5 },
    { kind: "search", name: "ok|suite", module: "/repo/ok.mjs", status: "incomplete", config: { seed: 3 }, plan: { strategy: "exhaustive", scenarios: [1, 2, 3] }, result: { runs: [1] }, outcome: { skipped: { "run-budget": 2 }, minimalFailureSet: undefined }, reports: { paths: {}, junit: '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="ok" tests="2" failures="0" time="0">\n</testsuite>\n' } },
    { kind: "search", name: "broken.mjs", module: "/repo/broken.mjs", status: "error", error: new Error("No 'cloudfault' or default config export") },
  ];
  const summary = buildSummary(records, { strict: true, cwd: "/repo" });
  assert.equal(summary.status, "fail");
  assert.deepEqual(summary.totals, { pass: 0, fail: 0, incomplete: 1, error: 1, resolved: 0, reproduced: 1 });
  assert.equal(summary.results[1].module, "ok.mjs");
  const markdown = renderSummaryMarkdown(summary);
  assert.match(markdown, /## CloudFault — FAIL/);
  assert.match(markdown, /\| ❌ \| checkout \| reproduced \| MFS: `A` · checks: `at-most-once` \|/);
  assert.match(markdown, /\| ⚠️ \| ok\\\|suite \| incomplete \| 1\/3 \| skipped by budget: run-budget=2 \|/);
  assert.match(markdown, /No 'cloudfault' or default config export/);
  const junit = combinedJunit(records);
  assert.match(junit, /<testsuites name="cloudfault" tests="4" failures="1" errors="1">/);
  assert.match(junit, /<testsuite name="ok" tests="2"/);
  assert.match(junit, /<testcase name="checkout-abc" classname="cloudfault.regressions"[^>]*>\n\s*<failure type="at-most-once" message="2 charges"\/>/);
  assert.doesNotMatch(junit.slice(1), /<\?xml/);
});

test("pin file names are stable per test and minimal failure set", () => {
  const artifact = { testName: "checkout/x", minimalFailureSet: [{ id: "B" }, { id: "A" }], scenario: { perturbations: [] } };
  const reordered = { ...artifact, minimalFailureSet: [{ id: "A" }, { id: "B" }] };
  assert.equal(pinFileName(artifact), pinFileName(reordered));
  assert.match(pinFileName(artifact), /^checkout-x-[0-9a-f]{10}\.json$/);
  assert.notEqual(pinFileName(artifact), pinFileName({ ...artifact, minimalFailureSet: [{ id: "A" }] }));
});

test("run writes the artifact even when state holds poisoned stubs (CLOU-3)", () => {
  const root = workspace();
  write(root, "suite.mjs", configSource({
    name: "poisoned",
    fails: 'active.has("A") && active.has("B")',
    state: '{ live: new Proxy({}, { get() { throw new Error("Attempted to use poisoned stub."); } }), charges: 2 }',
  }));
  const { status, output } = cloudfault(root, ["run", "suite.mjs"]);
  assert.equal(status, 1, output);
  assert.match(output, /Minimal Failure Set:\n\s+- A: A fails\n\s+- B: B fails/);
  const [artifactFile] = fs.readdirSync(path.join(root, ".cloudfault/failures"));
  const artifact = readJson(path.join(root, ".cloudfault/failures", artifactFile));
  assert.equal(artifact.state.live, "[unserializable: Attempted to use poisoned stub.]");
  assert.equal(artifact.state.charges, 2);
  assert.equal(artifact.replay.module, "./suite.mjs");
  for (const report of ["poisoned.json", "poisoned.junit.xml", "poisoned.html"]) assert.ok(fs.existsSync(path.join(root, ".cloudfault/reports", report)), report);
});

test("a baseline that fails without faults fails the run with an empty failure set", () => {
  const root = workspace();
  write(root, "suite.mjs", configSource({ name: "always-broken", fails: "true" }));
  const { status, output } = cloudfault(root, ["run", "suite.mjs"]);
  assert.equal(status, 1, output);
  assert.match(output, /Baseline fails/);
  const [artifactFile] = fs.readdirSync(path.join(root, ".cloudfault/failures"));
  assert.deepEqual(readJson(path.join(root, ".cloudfault/failures", artifactFile)).minimalFailureSet, []);
});

test("ci passes discovered configs and writes summary, JUnit, and the step summary", () => {
  const root = workspace();
  write(root, "a/cloudfault.config.mjs", configSource({ name: "suite-a" }));
  write(root, "b/cloudfault.config.mjs", configSource({ name: "suite-b", points: ["X"] }));
  const stepSummary = path.join(root, "step-summary.md");
  const { status, output } = cloudfault(root, ["ci", "--seed", "11", "--reports-dir", "out"], { GITHUB_STEP_SUMMARY: stepSummary });
  assert.equal(status, 0, output);
  assert.match(output, /PASS suite-a \(exhaustive, 6\/6 scenarios, seed 11\)/);
  assert.match(output, /CloudFault CI PASS exit 0/);
  const summary = readJson(path.join(root, "out/summary.json"));
  assert.equal(summary.status, "pass");
  assert.deepEqual(summary.results.map((result) => [result.name, result.status, result.seed]), [["suite-a", "pass", 11], ["suite-b", "pass", 11]]);
  assert.match(fs.readFileSync(path.join(root, "out/junit.xml"), "utf8"), /<testsuites name="cloudfault" tests="9" failures="0" errors="0">/);
  assert.match(fs.readFileSync(stepSummary, "utf8"), /## CloudFault — PASS/);
});

test("ci reports budget-truncated searches as incomplete and fails them only under --strict", () => {
  const root = workspace();
  write(root, "cloudfault.config.mjs", configSource({ name: "budgeted" }));
  const lenient = cloudfault(root, ["ci", "--max-runs", "2"]);
  assert.equal(lenient.status, 0, lenient.output);
  assert.match(lenient.output, /INCOMPLETE budgeted .*2\/6 scenarios/);
  assert.match(lenient.output, /pass --strict/);
  const strict = cloudfault(root, ["ci", "--strict", "--max-runs", "2"]);
  assert.equal(strict.status, 2, strict.output);
  assert.equal(readJson(path.join(root, ".cloudfault/reports/summary.json")).status, "incomplete");
});

test("ci exits 3 for config errors and 1 when any search fails", () => {
  const root = workspace();
  write(root, "broken/cloudfault.config.mjs", "export const cloudfault = { name: 'broken', faultPoints: [] };\n");
  const broken = cloudfault(root, ["ci", "broken"]);
  assert.equal(broken.status, 3, broken.output);
  assert.match(broken.output, /ERROR .* — CloudFault config must expose execute/);
  write(root, "bug/cloudfault.config.mjs", configSource({ name: "bug", fails: 'active.has("A")' }));
  const both = cloudfault(root, ["ci", "broken", "bug"]);
  assert.equal(both.status, 1, both.output);
  assert.match(both.output, /FAIL bug[\s\S]*minimal failure set: A/);
  const empty = cloudfault(root, ["ci", "missing-dir"]);
  assert.equal(empty.status, 3, empty.output);
});

test("pinned failures replay before the search: reproduced fails CI, resolved passes", () => {
  const root = workspace();
  write(root, "suites/cloudfault.config.mjs", configSource({ name: "pinnable", fails: 'active.has("B") && !process.env.CF_FIXED' }));
  const found = cloudfault(root, ["ci", "suites", "--no-regressions"]);
  assert.equal(found.status, 1, found.output);
  const artifact = readJson(path.join(root, ".cloudfault/reports/summary.json")).results[0].artifact;

  const pinned = cloudfault(root, ["pin", artifact]);
  assert.equal(pinned.status, 0, pinned.output);
  const [pinFile] = fs.readdirSync(path.join(root, "cloudfault-regressions"));
  assert.equal(readJson(path.join(root, "cloudfault-regressions", pinFile)).replay.module, "../suites/cloudfault.config.mjs");

  const regressed = cloudfault(root, ["ci", "suites"]);
  assert.equal(regressed.status, 1, regressed.output);
  assert.match(regressed.output, /REPRODUCED pinned pinnable/);
  assert.match(fs.readFileSync(path.join(root, ".cloudfault/reports/junit.xml"), "utf8"), /classname="cloudfault.regressions"/);

  const fixed = cloudfault(root, ["ci", "suites"], { CF_FIXED: "1" });
  assert.equal(fixed.status, 0, fixed.output);
  assert.match(fixed.output, /RESOLVED pinned pinnable/);
  assert.deepEqual(readJson(path.join(root, ".cloudfault/reports/summary.json")).totals, { pass: 1, fail: 0, incomplete: 0, error: 0, resolved: 1, reproduced: 0 });

  // The pin's module path is corpus-relative, so replay works from another directory.
  const elsewhere = cloudfault(os.tmpdir(), ["replay", path.join(root, "cloudfault-regressions", pinFile)]);
  assert.equal(elsewhere.status, 1, elsewhere.output);
  assert.match(elsewhere.output, /REPRODUCED/);
});
