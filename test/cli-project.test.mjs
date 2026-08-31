import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectProject, doctorProject, initProject } from "../packages/cli/lib/project.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudfault-project-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "wrangler.jsonc"), `{
    "name": "checkout-api",
    "main": "src/index.ts",
    "compatibility_date": "2026-08-20",
    "kv_namespaces": [{ "binding": "CONFIG", "id": "local" }],
    "d1_databases": [{ "binding": "DB", "database_name": "checkout", "database_id": "local" }],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "checkout-files" }],
    "queues": {
      "producers": [{ "binding": "FULFILLMENT", "queue": "fulfillment" }],
      "consumers": [{ "queue": "fulfillment" }]
    },
    "services": [{ "binding": "AUTH", "service": "auth-worker" }]
  }`);
  fs.writeFileSync(path.join(root, "src", "index.ts"), `
    import Stripe from "stripe";
    import OpenAI from "openai";
    const stripe = new Stripe("sk_test");
    const openai = new OpenAI();
    export { stripe, openai };
  `);
  return root;
}

test("project discovery combines Wrangler topology and source-level provider evidence", () => {
  const root = fixture();
  try {
    const project = detectProject(root);
    assert.equal(project.topology.name, "checkout-api");
    const bindings = new Map(project.topology.bindings.map((item) => [item.binding, item.type]));
    assert.equal(bindings.get("CONFIG"), "kv");
    assert.equal(bindings.get("DB"), "d1");
    assert.equal(bindings.get("FILES"), "r2");
    assert.equal(bindings.get("FULFILLMENT"), "queue-producer");
    assert.equal(bindings.get("AUTH"), "service");
    const adapters = project.adapters.map((item) => item.adapter);
    assert.ok(adapters.includes("stripe"));
    assert.ok(adapters.includes("openai"));
    assert.ok(project.recommendations.some((item) => item.id === "binding:CONFIG:kv-stale"));
    assert.ok(project.recommendations.some((item) => item.id === "adapter:stripe:ambiguous-payment"));
    assert.ok(project.recommendations.some((item) => item.id === "adapter:openai:stream"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("smart init writes binding-specific fault points and semantic recommendations", () => {
  const root = fixture();
  try {
    const result = initProject(root);
    const config = fs.readFileSync(result.configPath, "utf8");
    const recommendations = fs.readFileSync(result.recommendationPath, "utf8");
    assert.match(config, /staleKvRead\("CONFIG"/);
    assert.match(config, /d1CommitThenTimeout\("DB"/);
    assert.match(config, /r2CommitThenTimeout\("FILES"/);
    assert.match(config, /duplicateQueueDelivery\("FULFILLMENT"/);
    assert.match(config, /serviceTimeout\("AUTH"/);
    assert.match(recommendations, /ambiguous Stripe commits/i);
    assert.match(recommendations, /Interrupt OpenAI streams/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports optional runtime capabilities separately from core project validity", () => {
  const root = fixture();
  try {
    const report = doctorProject(root);
    assert.equal(report.project.topology.name, "checkout-api");
    assert.ok(report.checks.some((item) => item.name === "Node.js >= 20" && item.valid));
    assert.ok(report.checks.some((item) => item.name === "Wrangler configuration" && item.valid));
    assert.equal(typeof report.valid, "boolean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
