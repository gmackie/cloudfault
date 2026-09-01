import test from "node:test";
import assert from "node:assert/strict";
import { ScenarioController } from "../packages/core/dist/index.js";
import { AdapterRegistry, AdapterRuntime } from "../packages/adapter-sdk/dist/index.js";
import { providerLifecyclePerturbations, semanticAdapter } from "../packages/adapters/dist/index.js";

function faults(name, url, method = "POST") {
  const adapter = semanticAdapter(name);
  assert.ok(adapter, `missing ${name}`);
  const request = new Request(url, { method });
  const match = adapter.match(request);
  assert.ok(match, `${name} did not classify ${url}`);
  return { adapter, request, operation: match.operation, faults: adapter.faultSpace(match.operation, request) };
}

test("Anthropic exposes documented overload and stream-interruption semantics", () => {
  const result = faults("anthropic", "https://api.anthropic.com/v1/messages");
  const overload = result.faults.find((item) => item.kind === "anthropic-overloaded");
  assert.equal(overload?.metadata?.status, 529);
  assert.ok(result.faults.some((item) => item.kind === "stream-interrupt"));
});

test("GitHub exposes secondary-rate-limit behavior distinct from ordinary 429", () => {
  const result = faults("github", "https://api.github.com/repos/o/r/issues");
  const secondary = result.faults.find((item) => item.kind === "github-secondary-rate-limit");
  assert.equal(secondary?.metadata?.status, 403);
  assert.equal(secondary?.metadata?.headers?.["retry-after"], "60");
});

test("Slack exposes HTTP-200 application errors and the runtime records them as failures", async () => {
  const result = faults("slack", "https://slack.com/api/chat.postMessage");
  const applicationError = result.faults.find((item) => item.kind === "slack-application-error");
  assert.equal(applicationError?.metadata?.status, 200);

  const controller = new ScenarioController({ id: "slack-error", perturbations: [applicationError] });
  const runtime = new AdapterRuntime({
    registry: new AdapterRegistry().register(result.adapter),
    controller,
    upstream: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const response = await runtime.fetch(result.request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, false);
  assert.equal(controller.history.snapshot().at(-1)?.type, "fail");
});

test("Shopify GraphQL models error payloads that arrive with HTTP 200", () => {
  const result = faults("shopify", "https://store.myshopify.com/admin/api/2026-10/graphql.json");
  const throttled = result.faults.find((item) => item.kind === "shopify-graphql-throttled");
  assert.equal(throttled?.metadata?.status, 200);
  assert.equal(throttled?.metadata?.body?.errors?.[0]?.extensions?.code, "THROTTLED");
});

test("OAuth and async/webhook capabilities contribute lifecycle perturbations", () => {
  const google = faults("google", "https://www.googleapis.com/drive/v3/files", "GET");
  assert.ok(google.faults.some((item) => item.kind === "token-expired"));
  assert.ok(google.faults.some((item) => item.kind === "token-revoked"));

  const vercel = semanticAdapter("vercel");
  assert.ok(vercel);
  const lifecycle = providerLifecyclePerturbations(vercel);
  assert.ok(lifecycle.some((item) => item.kind === "webhook-duplicate"));
  assert.ok(lifecycle.some((item) => item.kind === "async-job-stalled"));
});
