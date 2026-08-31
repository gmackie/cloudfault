import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const cloudflare = await import(pathToFileURL(path.join(process.cwd(), "packages/cloudflare/dist/index.js")));

test("KV observer can legally lag authoritative state", () => {
  const kv = new cloudflare.EventuallyConsistentKv();
  kv.write("PENDING", 1);
  kv.write("PAID", 2);
  kv.setObserverVersion("FRA", 1);
  assert.equal(kv.latest().value, "PAID");
  assert.equal(kv.read("FRA").visibleValue, "PENDING");
  kv.converge("FRA");
  assert.equal(kv.read("FRA").visibleValue, "PAID");
});

test("Cloudflare degradation primitives distinguish definite and indeterminate outcomes", () => {
  const d1 = cloudflare.d1TransientNetworkError("DB");
  const service = cloudflare.serviceTimeout("PAYMENTS", "confirm");
  assert.equal(d1.kind, "transient-network-error");
  assert.equal(d1.observedOutcome, "definite-failure");
  assert.equal(service.observedOutcome, "indeterminate");
  assert.equal(service.actualOutcome, "unknown");
});
