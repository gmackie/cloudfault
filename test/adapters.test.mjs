import assert from "node:assert/strict";
import test from "node:test";
import { matchesHost } from "@cloudfault/adapter-sdk";
import {
  firstPartyAdapters,
  registerFirstPartyAdapters,
  slackAdapter,
  awsAdapter,
  paypalAdapter,
  algoliaAdapter,
} from "../packages/adapters/dist/index.js";

test("first-party unofficial catalog contains 25 semantic adapters", () => {
  assert.equal(firstPartyAdapters.length, 25);
  assert.equal(new Set(firstPartyAdapters.map((adapter) => adapter.manifest.name)).size, 25);
  assert.ok(firstPartyAdapters.every((adapter) => adapter.manifest.unofficial));
  assert.equal(registerFirstPartyAdapters().list().length, 25);
});

test("wildcard provider hosts match subdomains without matching the bare suffix", () => {
  assert.equal(matchesHost("*.amazonaws.com", "sqs.us-east-1.amazonaws.com"), true);
  assert.equal(matchesHost("*.amazonaws.com", "amazonaws.com"), false);
  assert.equal(matchesHost("api.stripe.com", "api.stripe.com"), true);
});

test("catalog classifies high-value provider operations semantically", () => {
  const slack = slackAdapter.match(new Request("https://slack.com/api/chat.postMessage", { method: "POST" }));
  assert.equal(slack?.operation.name, "message.post");
  assert.equal(slack?.operation.effect, "external-side-effect");

  const aws = awsAdapter.match(new Request("https://sqs.us-east-1.amazonaws.com/", { method: "POST" }));
  assert.equal(aws?.operation.name, "aws.action");

  const paypal = paypalAdapter.match(new Request("https://api-m.sandbox.paypal.com/v2/checkout/orders/O-123/capture", {
    method: "POST",
    headers: { "PayPal-Request-Id": "order-123" },
  }));
  assert.equal(paypal?.operation.name, "order.capture");
  assert.equal(paypal?.operation.idempotencyKey, "order-123");
  assert.equal(paypal?.operation.resource, "O-123");

  const algolia = algoliaAdapter.match(new Request("https://abc-dsn.algolia.net/1/indexes/products/query", { method: "POST" }));
  assert.equal(algolia?.operation.name, "index.query");
  assert.equal(algolia?.operation.effect, "query");
});

test("source detector identifies provider SDKs and raw API hosts", async () => {
  const adapters = await import("../packages/adapters/dist/index.js");
  const findings = adapters.detectAdaptersFromSource(`
    import OpenAI from "openai";
    import { WebClient } from "@slack/web-api";
    const raw = "https://api.stripe.com/v1/payment_intents";
  `);
  assert.deepEqual(findings.map((item) => item.adapter).sort(), ["openai", "slack", "stripe"]);
});
