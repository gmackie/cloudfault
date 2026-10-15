import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const core = await import(pathToFileURL(path.join(root, "packages/core/dist/index.js")));
const ESC = "\u001b[";

function failureArtifact() {
  const history = new core.History(() => 100);
  const op = { id: "op", name: "charge", process: 1, target: "stripe" };
  const fault = { id: "stripe:commit-timeout", kind: "commit-then-timeout", target: "stripe", description: "commits but times out" };
  history.invoke(op);
  history.perturb(fault, op);
  history.complete(op, "info", undefined, { actual: "committed", observed: "indeterminate" });
  const run = {
    scenario: { id: fault.id, perturbations: [fault] },
    history: history.snapshot(),
    checks: [
      { valid: false, checker: "one-charge", message: "two" },
      { valid: true, checker: "fulfilled-implies-paid" },
    ],
  };
  return core.createFailureArtifact({ testName: "checkout", run, minimalFailureSet: [fault], createdAt: "2026-10-15T00:00:00.000Z" });
}

test("text renderers stay plain unless color is requested", () => {
  const artifact = failureArtifact();
  assert.ok(!core.renderFailureArtifact(artifact).includes(ESC));
  assert.ok(!core.renderFailureArtifact(artifact, { color: false }).includes(ESC));
  assert.ok(!core.renderTimeline(artifact.history).includes(ESC));
});

test("colored rendering matches plain output once escapes are stripped", () => {
  const artifact = failureArtifact();
  const plain = core.renderFailureArtifact(artifact);
  const colored = core.renderFailureArtifact(artifact, { color: true });
  assert.notEqual(colored, plain);
  assert.equal(core.stripAnsi(colored), plain);
  assert.equal(core.stripAnsi(core.renderTimeline(artifact.history, { color: true })), core.renderTimeline(artifact.history));
});

test("checks, event types, and outcomes get distinct colors", () => {
  const artifact = failureArtifact();
  const checks = core.renderChecks(artifact.checks, { color: true });
  assert.match(checks, /\u001b\[31mFAIL/);
  assert.match(checks, /\u001b\[32mPASS/);
  const timeline = core.renderTimeline(artifact.history, { color: true });
  assert.match(timeline, /\u001b\[34minvoke/);
  assert.match(timeline, /\u001b\[35msemantic/);
  assert.match(timeline, /\u001b\[35m\[stripe:commit-timeout\]/);
  assert.match(timeline, /\u001b\[33minfo/);
  assert.match(timeline, /\u001b\[32mcommitted/);
  assert.match(timeline, /\u001b\[33mindeterminate/);
});

test("colorEnabled honours TTY, NO_COLOR, FORCE_COLOR, and TERM=dumb", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(core.colorEnabled(tty, {}), true);
  assert.equal(core.colorEnabled(pipe, {}), false);
  assert.equal(core.colorEnabled(undefined, {}), false);
  assert.equal(core.colorEnabled(tty, { NO_COLOR: "1" }), false);
  assert.equal(core.colorEnabled(tty, { NO_COLOR: "1", FORCE_COLOR: "1" }), false);
  assert.equal(core.colorEnabled(pipe, { FORCE_COLOR: "1" }), true);
  assert.equal(core.colorEnabled(tty, { FORCE_COLOR: "0" }), false);
  assert.equal(core.colorEnabled(tty, { TERM: "dumb" }), false);
});

test("CLI demo is plain when piped and colored with FORCE_COLOR", () => {
  const bin = path.join(root, "packages/cli/bin/cloudfault-v4.mjs");
  const run = (env) => execFileSync(process.execPath, [bin, "demo"], { env: { ...process.env, NO_COLOR: "", FORCE_COLOR: undefined, ...env }, encoding: "utf8" });
  const plain = run({});
  assert.ok(!plain.includes(ESC));
  assert.match(plain, /Final charges: 2/);
  const colored = run({ FORCE_COLOR: "1" });
  assert.ok(colored.includes(ESC));
  assert.equal(core.stripAnsi(colored), plain);
  assert.ok(!run({ FORCE_COLOR: "1", NO_COLOR: "1" }).includes(ESC));
});
