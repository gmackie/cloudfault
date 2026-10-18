import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const core = await import(pathToFileURL(path.join(process.cwd(), "packages/core/dist/index.js")));
const cloudflare = await import(pathToFileURL(path.join(process.cwd(), "packages/cloudflare/dist/index.js")));
const { recommendCloudFaultCoverage } = await import(pathToFileURL(path.join(process.cwd(), "packages/adapters/dist/index.js")));

function controller(...perturbations) {
  return new core.ScenarioController({ id: "scenario", perturbations });
}

/** A `pg`-style client over a tiny in-memory table. */
class FakePg {
  constructor() {
    this.rows = [];
    this.queries = 0;
  }
  async query(text, params = []) {
    this.queries += 1;
    if (/^insert/i.test(text)) {
      this.rows.push(params[0]);
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: this.rows.length, rows: this.rows.map((value) => ({ value })) };
  }
  release() { return "released"; }
}

/** A postgres.js-style callable: tagged template for queries, plain call for fragments. */
function fakePostgresJs() {
  const calls = [];
  const sql = (first, ...values) => {
    calls.push(first);
    if (Array.isArray(first) && "raw" in first) return Promise.resolve([{ text: first.join("?"), values }]);
    return { fragment: first };
  };
  return { sql, calls };
}

const history = (control) => control.history.snapshot();
const completions = (control) => history(control).filter((event) => ["ok", "fail", "info"].includes(event.type));

test("a Hyperdrive commit-then-timeout really commits, then surfaces as indeterminate", async () => {
  const pg = new FakePg();
  const control = controller(cloudflare.hyperdriveCommitThenTimeout("HYPERDRIVE"));
  const db = cloudflare.createHyperdriveFaultProxy(pg, { controller: control });
  await assert.rejects(db.query("insert into charges values ($1)", ["c1"]), cloudflare.HyperdriveIndeterminateError);
  assert.deepEqual(pg.rows, ["c1"], "the write reached the origin");
  const [completion] = completions(control);
  assert.equal(completion.type, "info");
  assert.equal(completion.outcome.actual, "committed");
  assert.equal(completion.outcome.observed, "indeterminate");
  assert.equal(db.release(), "released", "non-query methods pass through");
});

test("origin unavailability and pool exhaustion fail before anything is sent", async () => {
  for (const fault of [cloudflare.hyperdriveOriginUnavailable(), cloudflare.hyperdrivePoolExhausted()]) {
    const pg = new FakePg();
    const db = cloudflare.createHyperdriveFaultProxy(pg, { controller: controller(fault) });
    await assert.rejects(db.query("insert into charges values ($1)", ["c1"]), cloudflare.HyperdriveInjectedError);
    assert.equal(pg.queries, 0, `${fault.kind} must not reach the origin`);
  }
});

test("a cached read legally returns the pre-write result, and only for read-only queries", async () => {
  const pg = new FakePg();
  const control = controller(cloudflare.hyperdriveCachedRead());
  const db = cloudflare.createHyperdriveFaultProxy(pg, { controller: control });
  const before = await db.query("select value from charges");
  await db.query("insert into charges values ($1)", ["c1"]);
  const after = await db.query("select value from charges");
  assert.deepEqual(after, before, "the second read is served from the query cache");
  assert.deepEqual(pg.rows, ["c1"]);
  assert.equal(pg.queries, 2, "the cached read never reached the origin");
  assert.equal(control.activationCount(cloudflare.hyperdriveCachedRead().id), 1);
});

test("the proxy interposes on postgres.js tagged templates and leaves fragment calls alone", async () => {
  const { sql, calls } = fakePostgresJs();
  const control = controller(cloudflare.hyperdriveOriginUnavailable());
  const db = cloudflare.createHyperdriveFaultProxy(sql, { controller: control });
  assert.deepEqual(db({ id: 1 }, "id"), { fragment: { id: 1 } }, "a helper call is not a query");
  await assert.rejects(db`insert into charges values (${"c1"})`, cloudflare.HyperdriveInjectedError);
  assert.equal(calls.length, 1, "only the fragment call reached the driver");
  const invoke = history(control).find((event) => event.type === "invoke");
  assert.equal(invoke.operation.resource, "insert into charges values (?)");
});

test("Images faults fail info() and the output() of a transform chain", async () => {
  const binding = {
    async info() { return { format: "image/png", width: 10, height: 10 }; },
    input(stream) {
      const chain = { steps: [stream], transform(options) { this.steps.push(options); return this; }, async output(options) { return { steps: this.steps, options }; } };
      return chain;
    },
  };
  const ok = cloudflare.createImagesFaultProxy(binding, { controller: controller() });
  assert.deepEqual(await ok.input("bytes").transform({ width: 5 }).output({ format: "image/webp" }), { steps: ["bytes", { width: 5 }], options: { format: "image/webp" } });

  const transform = controller(cloudflare.imagesTransformError());
  const failing = cloudflare.createImagesFaultProxy(binding, { controller: transform });
  assert.deepEqual(await failing.info("bytes"), { format: "image/png", width: 10, height: 10 }, "a transform error does not affect info()");
  await assert.rejects(failing.input("bytes").transform({ width: 5 }).output({}), cloudflare.ImagesInjectedError);

  const down = cloudflare.createImagesFaultProxy(binding, { controller: controller(cloudflare.imagesUnavailable()) });
  await assert.rejects(down.info("bytes"), cloudflare.ImagesInjectedError);
});

test("topology records bindings CloudFault has no semantics for", () => {
  const topology = cloudflare.discoverWranglerTopology({
    hyperdrive: [{ binding: "HYPERDRIVE", id: "h" }],
    images: { binding: "IMAGES" },
    analytics_engine_datasets: [{ binding: "EVENTS", dataset: "events" }],
    send_email: [{ name: "MAIL" }],
    ratelimits: [{ name: "LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } }],
    dispatch_namespaces: [{ binding: "DISPATCH", namespace: "ns" }],
    mtls_certificates: [{ binding: "CERT", certificate_id: "c" }],
    secrets_store_secrets: [{ binding: "SECRET", store_id: "s", secret_name: "n" }],
    assets: { directory: "./public", binding: "ASSETS" },
    version_metadata: { binding: "VERSION" },
  });
  assert.deepEqual(
    topology.bindings.map((item) => `${item.type}:${item.binding}`).sort(),
    ["analytics-engine:EVENTS", "assets:ASSETS", "dispatch-namespace:DISPATCH", "hyperdrive:HYPERDRIVE", "images:IMAGES", "mtls-certificate:CERT", "rate-limit:LIMITER", "secrets-store:SECRET", "send-email:MAIL", "version-metadata:VERSION"],
  );
  assert.equal(cloudflare.discoverWranglerTopology({ assets: { directory: "./public" } }).bindings.length, 0, "assets without a binding name is not a binding");
});

test("recommendations cover Hyperdrive ambiguity and caching, and Images failures", () => {
  const ids = recommendCloudFaultCoverage([{ type: "hyperdrive", binding: "HYPERDRIVE" }, { type: "images", binding: "IMAGES" }], []).map((item) => item.id);
  assert.ok(ids.includes("binding:HYPERDRIVE:hyperdrive-ambiguity"));
  assert.ok(ids.includes("binding:HYPERDRIVE:hyperdrive-cache"));
  assert.ok(ids.includes("binding:IMAGES:images-failure"));
});
