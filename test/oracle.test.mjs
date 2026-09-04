import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import path from "node:path";

const core = await import(pathToFileURL(path.join(process.cwd(), "packages/core/dist/index.js")));
const sdk = await import(pathToFileURL(path.join(process.cwd(), "packages/adapter-sdk/dist/index.js")));
const emulate = await import(pathToFileURL(path.join(process.cwd(), "packages/adapter-sdk/dist/emulate.js")));

const { OPERATION_TOKEN_HEADER } = core;

const widgetAdapter = sdk.defineRulesAdapter({
  manifest: {
    name: "acme",
    provider: "Acme",
    unofficial: true,
    hosts: ["api.acme.example"],
    capabilities: ["rest"],
  },
  rules: [{
    methods: ["POST"],
    path: /^\/v1\/widgets$/,
    name: "widget.create",
    effect: "external-side-effect",
    retry: "unknown",
  }],
});

function registry() {
  return new sdk.AdapterRegistry().register(widgetAdapter);
}

/**
 * A backend that knows what it did, and whose HTTP status deliberately
 * disagrees with it. That disagreement is the point: it is what makes "asked"
 * distinguishable from "inferred from response.ok" rather than merely
 * differently labelled.
 *
 * - mode "commits"    : 200, and the write really landed.
 * - mode "lies-ok"    : 200, and nothing landed (an HTTP-200 application error,
 *                       the Slack/Shopify shape).
 * - mode "lies-error" : 500, and the write landed anyway (error-after-commit).
 */
class WidgetBackend {
  constructor(mode = "commits") {
    this.mode = mode;
    this.widgets = [];
    this.oracle = new core.RecordingOutcomeOracle("widget-backend");
  }

  async fetch(request) {
    const token = request.headers.get(OPERATION_TOKEN_HEADER) ?? undefined;
    const committed = this.mode !== "lies-ok";
    if (committed) this.widgets.push({ at: this.widgets.length });
    if (token) {
      // Recorded *after* the effect is durable, never before, and never from
      // the status code.
      this.oracle.record(token, {
        actual: committed ? "committed" : "not-committed",
        version: committed ? this.oracle.bumpVersion("acme:widgets") : undefined,
        evidence: { widgets: this.widgets.length, mode: this.mode },
      });
    }
    const status = this.mode === "lies-error" ? 500 : 200;
    return new Response(JSON.stringify({ ok: this.mode === "commits" }), {
      status,
      headers: { "content-type": "application/json", [OPERATION_TOKEN_HEADER]: token ?? "" },
    });
  }
}

function runtimeFor(backend, perturbations, options = {}) {
  const controller = new core.ScenarioController({ id: "oracle", perturbations });
  const runtime = new sdk.AdapterRuntime({
    registry: registry(),
    controller,
    upstream: (request) => backend.fetch(request),
    ...options,
  });
  return { controller, runtime };
}

const completion = (controller, type) =>
  controller.history.snapshot().find((event) => event.type === type && event.operation?.name === "widget.create");

test("with no oracle, a truncated response is honestly unknown rather than guessed", async () => {
  const backend = new WidgetBackend("commits");
  const { controller, runtime } = runtimeFor(backend, [
    sdk.malformedJson({ id: "acme:widget.create:malformed", target: "acme", operation: "widget.create" }),
  ]);

  await runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" });

  const info = completion(controller, "info");
  assert.equal(info.outcome.observed, "indeterminate");
  assert.equal(info.outcome.actual, "unknown");
  assert.equal(info.outcome.actualSource, "unknown", "nothing established this, so nothing may claim it");
});

test("with an oracle, the same truncated response records what the backend actually did", async () => {
  const backend = new WidgetBackend("commits");
  const { controller, runtime } = runtimeFor(
    backend,
    [sdk.malformedJson({ id: "acme:widget.create:malformed", target: "acme", operation: "widget.create" })],
    { oracle: backend.oracle },
  );

  await runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" });

  const info = completion(controller, "info");
  assert.equal(info.outcome.actual, "committed");
  assert.equal(info.outcome.actualSource, "oracle");
  assert.equal(info.outcome.version, 1);
  assert.deepEqual(info.outcome.evidence, { widgets: 1, mode: "commits" });
});

test("the response is destroyed after commit and the oracle is still asked", async () => {
  const backend = new WidgetBackend("commits");
  const { controller, runtime } = runtimeFor(
    backend,
    [sdk.commitThenTimeout({ id: "acme:widget.create:commit-timeout", target: "acme", operation: "widget.create" })],
    { oracle: backend.oracle },
  );

  await assert.rejects(
    () => runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" }),
    sdk.CloudFaultIndeterminateError,
  );

  assert.equal(backend.widgets.length, 1, "the provider really committed");
  const info = completion(controller, "info");
  assert.equal(info.outcome.actual, "committed");
  // The token was minted before the request went out, so the attempt whose
  // response CloudFault destroyed is still answerable.
  assert.equal(info.outcome.actualSource, "oracle");
  assert.equal(info.operation.token, controller.history.snapshot()[0].operation.token);
});

test("the oracle overrules a 200 that did not commit", async () => {
  const backend = new WidgetBackend("lies-ok");
  const withOracle = runtimeFor(backend, [], { oracle: backend.oracle });
  await withOracle.runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" });
  const asked = completion(withOracle.controller, "ok");
  assert.equal(asked.outcome.actual, "not-committed");
  assert.equal(asked.outcome.actualSource, "oracle");

  // The same request with no oracle deduces the opposite, and says so.
  const blind = runtimeFor(new WidgetBackend("lies-ok"), []);
  await blind.runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" });
  const inferred = completion(blind.controller, "ok");
  assert.equal(inferred.outcome.actual, "committed");
  assert.equal(inferred.outcome.actualSource, "inferred");
});

test("the oracle overrules a 500 that did commit", async () => {
  const backend = new WidgetBackend("lies-error");
  const { controller, runtime } = runtimeFor(backend, [], { oracle: backend.oracle });

  await runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" });

  const failed = completion(controller, "fail");
  assert.equal(failed.outcome.observed, "definite-failure", "the application was told it failed");
  assert.equal(failed.outcome.actual, "committed", "and it had not");
  assert.equal(failed.outcome.actualSource, "oracle");
});

test("an oracle that cannot answer degrades to unknown and never to a guess", async () => {
  const backend = new WidgetBackend("commits");
  const silent = {
    name: "silent",
    async outcomeFor() { return undefined; },
  };
  const throwing = {
    name: "throwing",
    async outcomeFor() { throw new Error("emulator unreachable"); },
  };

  for (const oracle of [silent, throwing]) {
    const { controller, runtime } = runtimeFor(
      backend,
      [sdk.commitThenTimeout({ id: `acme:${oracle.name}`, target: "acme", operation: "widget.create" })],
      { oracle },
    );
    await assert.rejects(() => runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" }));
    const info = completion(controller, "info");
    // Falls back to the fault's own declaration, which is labelled as such --
    // it is not an oracle answer and must not be readable as one.
    assert.equal(info.outcome.actual, "committed");
    assert.equal(info.outcome.actualSource, "declared", `${oracle.name} must not be credited with an answer`);
  }
});

test("outcomeMetadata precedence is oracle > declared > inferred > unknown", () => {
  const asked = core.outcomeMetadata({ actual: "not-committed" }, {
    observed: "success",
    declared: "committed",
    inferred: "committed",
  });
  assert.deepEqual(
    { actual: asked.actual, source: asked.actualSource },
    { actual: "not-committed", source: "oracle" },
  );

  assert.equal(core.outcomeMetadata(undefined, { observed: "success", declared: "committed", inferred: "unknown" }).actualSource, "declared");
  assert.equal(core.outcomeMetadata(undefined, { observed: "success", inferred: "committed" }).actualSource, "inferred");
  const nothing = core.outcomeMetadata(undefined, { observed: "indeterminate" });
  assert.equal(nothing.actual, "unknown");
  assert.equal(nothing.actualSource, "unknown");
});

/* --------------------------------------------------------------------------
 * The HTTP oracle, against a server speaking the exact control-plane protocol
 * the emulate Cloudflare emulator serves.
 * -------------------------------------------------------------------------- */

async function startEmulatorLike() {
  const outcomes = new Map();
  const versions = new Map();
  let mode = "commits";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith("/_cloudfault/outcome/")) {
      const token = decodeURIComponent(url.pathname.slice("/_cloudfault/outcome/".length));
      const outcome = outcomes.get(token);
      // Honesty on the provider side: an unknown token is a 404, not a guess.
      if (!outcome) return json(404, { error: "unknown operation token" });
      return json(200, outcome);
    }
    if (url.pathname.startsWith("/_cloudfault/version/")) {
      const resource = decodeURIComponent(url.pathname.slice("/_cloudfault/version/".length));
      return json(200, { resource, version: versions.get(resource) ?? null });
    }
    if (url.pathname === "/_cloudfault/snapshot") {
      return json(200, { operations: [...outcomes.keys()], versions: Object.fromEntries(versions) });
    }
    if (url.pathname === "/_cloudfault/reset" && req.method === "POST") {
      outcomes.clear();
      versions.clear();
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/v1/widgets" && req.method === "POST") {
      const token = req.headers[OPERATION_TOKEN_HEADER];
      const committed = mode === "commits";
      if (committed) versions.set("acme:widgets", (versions.get("acme:widgets") ?? 0) + 1);
      if (token) {
        outcomes.set(token, {
          actual: committed ? "committed" : "not-committed",
          version: versions.get("acme:widgets"),
          evidence: { mode },
        });
      }
      res.writeHead(200, { "content-type": "application/json", [OPERATION_TOKEN_HEADER]: token ?? "" });
      res.end(JSON.stringify({ ok: committed }));
      return;
    }
    json(404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    setMode(next) { mode = next; },
    async close() { server.close(); await once(server, "close"); },
  };
}

test("httpOutcomeOracle asks a real control plane over the wire", async (t) => {
  const emulator = await startEmulatorLike();
  t.after(() => emulator.close());

  const oracle = emulate.httpOutcomeOracle({ baseUrl: emulator.baseUrl });
  const controller = new core.ScenarioController({
    id: "http-oracle",
    perturbations: [sdk.commitThenTimeout({
      id: "acme:widget.create:commit-timeout",
      target: "acme",
      operation: "widget.create",
    })],
  });
  const runtime = new sdk.AdapterRuntime({
    registry: registry(),
    controller,
    // The token header survives the emulate URL rewrite, which is what lets a
    // CloudFault-classified request reach a locally hosted emulator at all.
    upstream: emulate.emulateBackend(globalThis.fetch, { baseUrl: emulator.baseUrl }),
    oracle,
  });

  await assert.rejects(
    () => runtime.fetch("https://api.acme.example/v1/widgets", { method: "POST", body: "{}" }),
    sdk.CloudFaultIndeterminateError,
  );

  const info = completion(controller, "info");
  assert.equal(info.outcome.actual, "committed");
  assert.equal(info.outcome.actualSource, "oracle");
  assert.equal(info.outcome.version, 1);
  assert.equal(await oracle.versionOf("acme:widgets"), 1);
});

test("an unknown token 404s and stays unknown", async (t) => {
  const emulator = await startEmulatorLike();
  t.after(() => emulator.close());
  const oracle = emulate.httpOutcomeOracle({ baseUrl: emulator.baseUrl });

  assert.equal(await oracle.outcomeFor("op_never_seen"), undefined);
  assert.equal(await oracle.versionOf("acme:widgets"), undefined);

  const metadata = core.outcomeMetadata(await core.askOracle(oracle, "op_never_seen"), {
    observed: "indeterminate",
  });
  assert.equal(metadata.actual, "unknown");
  assert.equal(metadata.actualSource, "unknown");
});

test("an unreachable oracle is unknown, not committed", async () => {
  const oracle = emulate.httpOutcomeOracle({ baseUrl: "http://127.0.0.1:1" });
  assert.equal(await core.askOracle(oracle, "op_anything"), undefined);
});

test("the emulator's contract-probe refusal is surfaced, not swallowed", async () => {
  const refuse = async () => new Response(
    JSON.stringify({ error: '"partial-batch-application" is a contract probe, not a fidelity claim' }),
    { status: 400 },
  );
  await assert.rejects(
    () => emulate.postFaultPlan({
      baseUrl: "http://localhost:4007",
      fetch: refuse,
      perturbations: [{ id: "p", kind: "partial-batch-application", target: "DB" }],
    }),
    /Emulator refused the fault plan \(400\).*contract probe/s,
  );
});

/* --------------------------------------------------------------------------
 * The binding seam. `env.DB` has no response headers, so the token travels
 * through whatever the caller wires up rather than through HTTP.
 * -------------------------------------------------------------------------- */

const cloudflare = await import(pathToFileURL(path.join(process.cwd(), "packages/cloudflare/dist/index.js")));

test("a D1 oracle overrules what the binding proxy could deduce on its own", async () => {
  const oracle = new core.RecordingOutcomeOracle("fake-d1");
  let pending;

  const backing = {
    prepare(sql) {
      return {
        sql,
        bind() { return this; },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
    },
    async batch(statements) {
      // The backend quietly drops the last statement -- a thing only the
      // backend can know, and precisely the class of outcome CloudFault cannot
      // deduce from a call that returned normally.
      const kept = statements.slice(0, -1);
      const results = [];
      for (const statement of kept) results.push(await statement.run());
      oracle.record(pending, {
        actual: "committed",
        version: oracle.bumpVersion("d1:fixture"),
        applied: statements.map((_s, index) => ({ index, committed: index < kept.length })),
        evidence: { rows_written: kept.length },
      });
      return results;
    },
  };

  const controller = new core.ScenarioController({ id: "d1-oracle", perturbations: [] });
  const db = cloudflare.createD1FaultProxy(backing, {
    controller,
    target: "DB",
    oracle,
    token: () => {
      pending = core.mintOperationToken();
      return pending;
    },
  });

  await db.batch([db.prepare("UPDATE a SET b = 1"), db.prepare("INSERT INTO c VALUES (1)")]);

  const ok = controller.history.snapshot().find((event) => event.type === "ok" && event.operation?.name === "d1.batch");
  assert.equal(ok.outcome.actualSource, "oracle");
  assert.deepEqual(ok.outcome.applied, [
    { index: 0, committed: true },
    { index: 1, committed: false },
  ], "the proxy would have reported both statements applied; the backend knows better");
  assert.equal(ok.outcome.version, 1);
  assert.equal(ok.operation.token, pending);
});
