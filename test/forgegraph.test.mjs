import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planScenarios } from "@cloudfault/core";
import {
  ForgeGraphClient,
  ForgeGraphError,
  dispatchExposure,
  evidenceRunId,
  planEvidence,
  runEvidence,
  staticCoverageEvidence,
  toTestRunEvidence,
} from "@cloudfault/forgegraph";
import { forgeGraphCredentials, parseFlags, pushDrafts, repositoryDrafts } from "../packages/cli/lib/forgegraph.mjs";
import { findWranglers, inspectRepository } from "../packages/cli/lib/project.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function run(id, valid = true, durationMs = 5) {
  return {
    scenario: { id, perturbations: [] },
    history: [],
    checks: [{ checker: "at-most-once", valid, message: valid ? undefined : "duplicate charge" }],
    durationMs,
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("static coverage passes covered bindings and adapters, skips bindings without a semantic pack", () => {
  const draft = staticCoverageEvidence([
    { config: "wrangler.jsonc", bindings: [{ type: "d1", binding: "DB" }, { type: "kv", binding: "CACHE" }, { type: "vectorize", binding: "VEC" }], adapters: ["stripe"] },
    { config: "apps/jobs/wrangler.toml", bindings: [{ type: "ai", binding: "AI" }], adapters: ["stripe", "openai"] },
  ]);
  assert.equal(draft.suiteName, "cloudfault:static");
  assert.equal(draft.status, "passed");
  assert.equal(draft.totalTests, 6);
  assert.equal(draft.passedTests, 4);
  assert.equal(draft.skippedTests, 2);
  assert.equal(draft.failedTests, 0);
  assert.equal(draft.coveragePercent, 50);
  assert.match(draft.coverageSummary, /2 workers; 2\/4 bindings with semantic packs; adapters: openai, stripe; no pack for: ai, vectorize/);
});

test("static coverage with no Worker found is cancelled, not passed or failed", () => {
  const draft = staticCoverageEvidence([]);
  assert.equal(draft.status, "cancelled");
  assert.equal(draft.totalTests, 0);
  assert.match(draft.coverageSummary, /No wrangler configuration/);
});

test("a plan becomes queued evidence whose every scenario is skipped", () => {
  const point = (id) => ({ id, target: id, choices: [{ id: `${id}:a`, kind: "a", target: id, description: "a" }, { id: `${id}:b`, kind: "b", target: id, description: "b" }] });
  const plan = planScenarios([point("DB"), point("CACHE")], { strategy: "exhaustive", maxDepth: 1 });
  const draft = planEvidence(plan, { reason: "not executed" });
  assert.equal(draft.suiteName, "cloudfault:baseline");
  assert.equal(draft.status, "queued");
  assert.equal(draft.totalTests, plan.scenarios.length);
  assert.equal(draft.skippedTests, plan.scenarios.length);
  assert.equal(draft.passedTests + draft.failedTests, 0);
  assert.match(draft.coverageSummary, /exhaustive plan: 4 scenarios over 2 fault points/);
});

test("run evidence counts the baseline, failing scenarios and budget-skipped scenarios", () => {
  const passing = runEvidence("checkout", run("baseline"), [run("s1"), run("s2")]);
  assert.deepEqual(
    { status: passing.status, total: passing.totalTests, passed: passing.passedTests, failed: passing.failedTests, duration: passing.durationMs },
    { status: "passed", total: 3, passed: 3, failed: 0, duration: 15 },
  );
  assert.equal(passing.suiteName, "cloudfault:checkout");

  const failing = runEvidence("checkout", run("baseline"), [run("s1", false), run("s2")], { skipped: 4 });
  assert.equal(failing.status, "failed");
  assert.equal(failing.failedTests, 1);
  assert.equal(failing.skippedTests, 4);
  assert.equal(failing.totalTests, 7);
  assert.match(failing.coverageSummary, /1\/3 scenarios violated invariants \(at-most-once\)/);
});

test("run IDs are stable per suite, app and commit, and binding drops absent optionals", () => {
  assert.equal(evidenceRunId("cloudfault:static", "crucible", SHA), "cloudfault:static:crucible:0123456789ab");
  assert.equal(evidenceRunId("cloudfault:static", "crucible", SHA), evidenceRunId("cloudfault:static", "crucible", `${SHA.slice(0, 12)}ffff`));
  const evidence = toTestRunEvidence(staticCoverageEvidence([]), { changesetId: "cs-1", externalRunId: "run-1" });
  assert.equal(evidence.type, "test_run");
  assert.equal(evidence.source, "gitea_ci");
  assert.equal(evidence.changesetId, "cs-1");
  assert.ok(!("coveragePercent" in evidence));
  assert.ok(!("durationMs" in evidence));
});

test("only manual or absent lanes are free of dispatch exposure", () => {
  assert.equal(dispatchExposure([]).safe, true);
  assert.equal(dispatchExposure([{ environment: "staging", executionMode: "manual" }]).safe, true);
  const exposed = dispatchExposure([{ environment: "staging", executionMode: "auto" }, { environment: "prod_main", executionMode: "approval_gated" }]);
  assert.equal(exposed.safe, false);
  assert.deepEqual(exposed.reasons, ["staging is auto", "prod_main is approval_gated"]);
});

function fakeForgeGraph({ changesets = [], details = {}, policies = {}, pushes = [] } = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ method: init.method ?? "GET", path: parsed.pathname + parsed.search, headers: init.headers, body: init.body });
    if (parsed.pathname === "/api/fg/changesets") return json({ changesets });
    if (parsed.pathname.startsWith("/api/fg/changesets/")) {
      const id = decodeURIComponent(parsed.pathname.split("/").pop());
      return details[id] ? json(details[id]) : json({ error: "Changeset not found" }, 404);
    }
    if (parsed.pathname === "/api/trpc/executionPolicy.get") {
      const input = JSON.parse(parsed.searchParams.get("input")).json;
      return json({ result: { data: { json: policies[input.environment] ?? null } } });
    }
    if (parsed.pathname === "/api/evidence") {
      pushes.push(JSON.parse(init.body));
      return json({ testRunId: `tr-${pushes.length}`, status: "ok" });
    }
    return json({ error: "not found" }, 404);
  };
  return { client: new ForgeGraphClient({ server: "https://fg.test/", token: "secret-token", fetch: fetchImpl }), calls, pushes };
}

test("changesetForSha checks short-SHA-titled changesets first and requires an exact head match", async () => {
  const { client, calls } = fakeForgeGraph({
    changesets: [
      { id: "old", title: "fix: thing", status: "merged", createdAt: "2026-01-01T00:00:00Z" },
      { id: "pr", title: "Merge pull request #9", status: "merged", createdAt: "2026-03-01T00:00:00Z" },
      { id: "push", title: SHA.slice(0, 8), status: "merged", createdAt: "2026-02-01T00:00:00Z" },
    ],
    details: {
      old: { id: "old", headSha: "f".repeat(40) },
      pr: { id: "pr", headSha: "e".repeat(40) },
      push: { id: "push", title: SHA.slice(0, 8), status: "merged", headSha: SHA },
    },
  });
  const found = await client.changesetForSha("crucible", SHA);
  assert.equal(found.id, "push");
  const detailCalls = calls.filter((call) => call.path.startsWith("/api/fg/changesets/"));
  assert.equal(detailCalls.length, 1, "the short-SHA title is tried before anything else");
  assert.equal(calls[0].headers.authorization, "Bearer secret-token");
  assert.equal(await client.changesetForSha("crucible", "a".repeat(40)), undefined);
});

test("execution policies are read per lane through tRPC; HTTP errors surface as ForgeGraphError", async () => {
  const { client } = fakeForgeGraph({ policies: { prod_main: { environment: "prod_main", executionMode: "auto", repositoryId: "r" } } });
  assert.deepEqual(await client.executionPolicies("repo-1"), [{ environment: "prod_main", executionMode: "auto" }]);
  await assert.rejects(client.changeset("missing"), (error) => error instanceof ForgeGraphError && error.status === 404);
});

test("pushDrafts refuses terminal evidence on a merged changeset with a non-manual lane", async () => {
  const drafts = [staticCoverageEvidence([{ config: "wrangler.jsonc", bindings: [{ type: "d1", binding: "DB" }], adapters: [] }]), planEvidence(planScenarios([], {}))];
  const auto = [{ environment: "staging", executionMode: "auto" }];

  const exposed = fakeForgeGraph();
  const held = await pushDrafts(exposed.client, { app: "crucible", sha: SHA, changeset: { id: "cs", status: "merged" }, drafts, policies: auto });
  assert.deepEqual(held.results.map((item) => item.pushed), [false, true], "passed is held; queued has no outcome and is pushed");
  assert.match(held.results[0].reason, /staging is auto/);
  assert.equal(exposed.pushes.length, 1);
  assert.equal(exposed.pushes[0].suiteName, "cloudfault:baseline");
  assert.equal(exposed.pushes[0].externalRunId, `cloudfault:baseline:crucible:${SHA.slice(0, 12)}`);

  const open = fakeForgeGraph();
  await pushDrafts(open.client, { app: "crucible", sha: SHA, changeset: { id: "cs", status: "open" }, drafts, policies: auto });
  assert.equal(open.pushes.length, 2, "open changesets are meant to feed their gates");

  const allowed = fakeForgeGraph();
  await pushDrafts(allowed.client, { app: "crucible", sha: SHA, changeset: { id: "cs", status: "merged" }, drafts, policies: auto, allowDispatch: true });
  assert.equal(allowed.pushes.length, 2);

  const dry = fakeForgeGraph();
  const result = await pushDrafts(dry.client, { app: "crucible", sha: SHA, changeset: { id: "cs", status: "open" }, drafts, policies: [], dryRun: true });
  assert.equal(dry.pushes.length, 0);
  assert.ok(result.results.every((item) => item.reason === "dry run"));
});

test("credentials come from the environment first, then the forge login file", () => {
  assert.deepEqual(forgeGraphCredentials({ FORGEGRAPH_TOKEN: "t", FORGEGRAPH_SERVER: "https://x" }), { server: "https://x", token: "t" });
  const home = tempDir("cloudfault-fg-home-");
  try {
    fs.writeFileSync(path.join(home, "credentials.json"), JSON.stringify({ server: "https://forgegraf.com", token: "stored" }));
    assert.deepEqual(forgeGraphCredentials({ FORGEGRAPH_HOME: home }), { server: "https://forgegraf.com", token: "stored" });
    fs.rmSync(path.join(home, "credentials.json"));
    assert.throws(() => forgeGraphCredentials({ FORGEGRAPH_HOME: home }), /No ForgeGraph credentials/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("flag parsing handles values, booleans, inline values and repeats", () => {
  const { flags, positional } = parseFlags(["static", "apps/web", "--app", "crucible", "--dry-run", "--app=bob", "--out", "x.json"]);
  assert.deepEqual(positional, ["static", "apps/web"]);
  assert.deepEqual(flags.app, ["crucible", "bob"]);
  assert.equal(flags["dry-run"], true);
  assert.equal(flags.out, "x.json");
});

function monorepo() {
  const root = tempDir("cloudfault-monorepo-");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("apps/web/wrangler.jsonc", `{ // web
    "name": "web",
    "d1_databases": [{ "binding": "DB", "database_name": "web", "database_id": "x" }],
    "kv_namespaces": [{ "binding": "CACHE", "id": "y" }],
    "hyperdrive": [{ "binding": "PG", "id": "z" }]
  }`);
  write("apps/web/src/pay.ts", `import Stripe from "stripe"; export const s = new Stripe("sk_test");`);
  write("apps/jobs/wrangler.toml", `name = "jobs"\n[[queues.producers]]\nbinding = "JOBS"\nqueue = "jobs"\n[[r2_buckets]]\nbinding = "FILES"\nbucket_name = "files"\n`);
  write("apps/web/test/fixtures/wrangler.jsonc", `{ "name": "fixture", "kv_namespaces": [{ "binding": "NOPE", "id": "n" }] }`);
  write("node_modules/pkg/wrangler.toml", `name = "vendored"\n`);
  return root;
}

test("repository discovery finds every Worker, reads TOML through Wrangler, and skips fixtures", () => {
  const root = monorepo();
  try {
    assert.deepEqual(findWranglers(root).map((file) => path.relative(root, file)).sort(), ["apps/jobs/wrangler.toml", "apps/web/wrangler.jsonc"]);
    const workers = Object.fromEntries(inspectRepository(root).map((worker) => [worker.config, worker]));
    assert.deepEqual(workers["apps/jobs/wrangler.toml"].topology.bindings.map((item) => `${item.type}:${item.binding}`).sort(), ["queue-producer:JOBS", "r2:FILES"]);
    assert.deepEqual(workers["apps/web/wrangler.jsonc"].adapters.map((item) => item.adapter), ["stripe"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repository drafts combine static coverage with a baseline plan over the starter fault points", async () => {
  const root = monorepo();
  try {
    const { staticDraft, baselineDraft, plan } = await repositoryDrafts(root);
    assert.equal(staticDraft.status, "passed");
    // DB, CACHE, PG (hyperdrive), JOBS, FILES covered + stripe adapter.
    assert.equal(staticDraft.passedTests, 6);
    assert.equal(staticDraft.skippedTests, 0);
    assert.equal(staticDraft.coveragePercent, 100);
    assert.equal(plan.metadata.faultPoints, 5);
    assert.ok(plan.scenarios.length > 0 && plan.scenarios.length <= 100);
    assert.equal(baselineDraft.status, "queued");
    assert.equal(baselineDraft.skippedTests, plan.scenarios.length);
    assert.match(baselineDraft.coverageSummary, /hybrid plan/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
