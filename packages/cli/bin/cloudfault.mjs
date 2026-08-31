#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importBuilt(packageName) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidate = path.resolve(here, "../../", packageName, "dist/index.js");
  try {
    return await import(pathToFileURL(candidate));
  } catch (error) {
    throw new Error(
      `CloudFault package ${packageName} is not built. Run \`npm run build\` first.\n${error}`,
    );
  }
}

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function inspect(file) {
  const raw = await fs.readFile(file, "utf8");
  const config = JSON.parse(stripJsonComments(raw));
  const bindings = [];

  for (const item of config.kv_namespaces ?? []) {
    bindings.push({ binding: item.binding, type: "KV", semantics: "eventually consistent" });
  }
  for (const item of config.d1_databases ?? []) {
    bindings.push({ binding: item.binding, type: "D1", semantics: "transient backend errors" });
  }
  for (const item of config.r2_buckets ?? []) {
    bindings.push({ binding: item.binding, type: "R2", semantics: "transient capacity/backend errors" });
  }
  for (const item of config.services ?? []) {
    bindings.push({ binding: item.binding, type: "Service", semantics: "latency / timeout / 5xx" });
  }
  for (const item of config.queues?.producers ?? []) {
    bindings.push({ binding: item.binding, type: "Queue", semantics: "at-least-once delivery" });
  }

  console.log("CloudFault topology\n");
  if (!bindings.length) {
    console.log("No supported bindings discovered.");
    return;
  }
  for (const entry of bindings) {
    console.log(`${entry.binding.padEnd(20)} ${entry.type.padEnd(10)} ${entry.semantics}`);
  }
}

async function demo() {
  const core = await importBuilt("core");
  const cloudflare = await importBuilt("cloudflare");
  const stripe = await importBuilt("stripe");

  const stale = cloudflare.kvStaleReadFault("ORDER_STATE", "FRA", 1);
  const ambiguous = stripe.stripeCommitThenTimeout;
  const candidates = [stale, ambiguous];

  async function scenario(active) {
    const ids = new Set(active.map((fault) => fault.id));
    const history = new core.History();
    const state = { charges: 1, kvVersion: "PAID" };

    history.invoke("checkout", "checkout", { orderId: "812" });

    const staleRead = ids.has(stale.id);
    const observedOrderState = staleRead ? "PENDING" : state.kvVersion;
    history.complete("checkout", "ok", { observedOrderState });

    if (observedOrderState === "PENDING") {
      history.invoke("stripe-1", "stripe.payment.confirm", { orderId: "812" });
      if (ids.has(ambiguous.id)) {
        state.charges += 1;
        history.complete(
          "stripe-1",
          "info",
          { timeout: true },
          {
            target: "stripe",
            faultId: ambiguous.id,
            actualOutcome: "committed",
            observedOutcome: "indeterminate",
          },
        );
        history.invoke("stripe-2", "stripe.payment.confirm", { orderId: "812", retry: true });
        state.charges += 1;
        history.complete("stripe-2", "ok", { charge: "ch_retry" });
      }
    }

    const check = state.charges <= 1
      ? { valid: true }
      : {
          valid: false,
          invariant: "at-most-one-charge",
          message: `order 812 has ${state.charges} successful charges`,
          witness: { charges: state.charges },
        };

    return { history, check, state };
  }

  const baseline = await scenario([]);
  const combined = await scenario(candidates);
  const minimum = await core.minimizeFailureSet(candidates, async (faults) => scenario(faults));

  console.log("CloudFault semantic failure demo\n");
  console.log(`Baseline: ${baseline.check.valid ? "PASS" : "FAIL"}`);
  console.log(`Combined scenario: ${combined.check.valid ? "PASS" : "FAIL"}`);
  console.log(`Final charges: ${combined.state.charges}\n`);

  if (!combined.check.valid) {
    console.log(`Invariant: ${combined.check.invariant}`);
    console.log("Minimal Failure Set:");
    for (const fault of minimum) console.log(`  - ${fault.id}: ${fault.label}`);
    console.log("\nHistory:");
    console.log(combined.history.toText());
  }
}

const [command, arg] = process.argv.slice(2);

if (command === "inspect" && arg) {
  await inspect(arg);
} else if (command === "demo") {
  await demo();
} else {
  console.log(`CloudFault\n\nUsage:\n  cloudfault inspect <wrangler.jsonc>\n  cloudfault demo`);
}
