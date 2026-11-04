import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFailureArtifact, minimizeFailureSet } from "@cloudfault/core";
import { ambiguous, cloudfault, runScenario, stale } from "./scenario.mjs";

test("real workerd fixture exposes the stale-state + ambiguous-commit bug and reduces its MFS", async () => {
  const baseline = await runScenario([]);
  const staleOnly = await runScenario([stale]);
  const ambiguousOnly = await runScenario([ambiguous]);
  const combined = await runScenario([stale, ambiguous]);

  assert.equal(baseline.state.charges, 0);
  assert.equal(staleOnly.state.charges, 1);
  assert.equal(ambiguousOnly.state.charges, 0);
  assert.equal(combined.state.charges, 2);
  assert.ok(combined.checks.some((check) => !check.valid && check.checker === "at-most-one-new-charge"));

  const minimized = await minimizeFailureSet([stale, ambiguous], async (candidate) => {
    const result = await runScenario(candidate);
    return result.checks.some((check) => !check.valid);
  });
  assert.deepEqual(minimized.minimal.map((item) => item.id), [stale.id, ambiguous.id]);

  const artifact = createFailureArtifact({
    testName: cloudfault.name,
    run: combined,
    minimalFailureSet: minimized.minimal,
    replay: cloudfault.replay,
  });
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.minimalFailureSet.length, 2);
  // The CLI writes this artifact after the harness has closed.
  assert.doesNotThrow(() => JSON.stringify(artifact));
});

test("cloudfault run on the checkout config writes its artifact and reports, then exits 1 (CLOU-3)", { timeout: 300_000 }, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cloudfault-checkout-"));
  // No leading ./ on purpose: a bare relative path must load as a file, not a package.
  const result = spawnSync(process.execPath, [path.join(root, "packages/cli/bin/cloudfault-v4.mjs"), "run", "examples/checkout/scenario.mjs", "--reports-dir", path.join(out, "reports"), "--failures-dir", path.join(out, "failures")], {
    cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "" }, timeout: 240_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.doesNotMatch(output, /poisoned stub/);
  assert.match(output, /Minimal Failure Set:\n\s+- ORDER_STATE:stale[^\n]*\n\s+- PAYMENTS:charge:commit-timeout/);
  const [artifactFile] = fs.readdirSync(path.join(out, "failures"));
  const artifact = JSON.parse(fs.readFileSync(path.join(out, "failures", artifactFile), "utf8"));
  assert.equal(artifact.state.charges, 2);
  const reports = fs.readdirSync(path.join(out, "reports")).sort();
  assert.deepEqual(reports, ["checkout-stale-kv-ambiguous-payment.html", "checkout-stale-kv-ambiguous-payment.json", "checkout-stale-kv-ambiguous-payment.junit.xml"]);
});
