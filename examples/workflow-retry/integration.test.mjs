import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { applyWorkflowScenario, workflowStepRetry } from "@cloudfault/cloudflare";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, "worker", "wrangler.jsonc");

async function run(perturbations) {
  const server = createTestHarness({ workers: [{ configPath }] });
  await server.listen();
  try {
    // Cloudflare's Workflow introspector is the control-plane session and is
    // intentionally valid across modifyAll(). The Worker runtime handle used to
    // create it may be invalidated by the Miniflare reload, so dispatch through
    // server.fetch() afterwards rather than retaining that WorkerHandle.
    const worker = server.getWorker("cloudfault-workflow-retry");
    const workflow = await worker.introspectWorkflow("ORDER_FLOW");
    await applyWorkflowScenario(workflow, { perturbations }, {
      target: "ORDER_FLOW",
      disableRetryDelays: true,
    });

    const response = await server.fetch("https://workflow.test/start?orderId=812", { method: "POST" });
    assert.equal(response.status, 200);
    const started = await response.json();
    assert.equal(started.orderId, "812");

    const instances = await workflow.get();
    assert.equal(instances.length, 1);
    const [instance] = instances;
    await instance.waitForStatus("complete");
    return await instance.getOutput();
  } finally {
    // modifyAll() reloads Miniflare and can poison the runtime stub used by
    // WorkflowIntrospector.dispose(). Closing the owning harness tears down the
    // introspection session and all runtime objects without touching that stale
    // stub again.
    await server.close();
  }
}

test("real Workflow baseline completes each step on its first attempt", async () => {
  const output = await run([]);
  assert.deepEqual(output, {
    orderId: "812",
    charged: true,
    chargeAttempt: 1,
    fulfilled: true,
    fulfillmentAttempt: 1,
  });
});

test("CloudFault injects a one-time Workflow step failure and the real runtime retries to convergence", async () => {
  const output = await run([workflowStepRetry("ORDER_FLOW", "charge")]);
  assert.equal(output.orderId, "812");
  assert.equal(output.charged, true);
  assert.equal(output.fulfilled, true);
  assert.equal(output.chargeAttempt, 2);
  assert.equal(output.fulfillmentAttempt, 1);
});
