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
    // Workflow modifiers reload Miniflare. Any WorkerHandle/introspector obtained
    // before modifyAll() becomes poisoned, so the first introspector is control-
    // plane-only: configure it, then discard it without calling it again.
    const initialWorker = server.getWorker("cloudfault-workflow-retry");
    const initialWorkflow = await initialWorker.introspectWorkflow("ORDER_FLOW");
    await applyWorkflowScenario(initialWorkflow, { perturbations }, {
      target: "ORDER_FLOW",
      disableRetryDelays: true,
    });

    // Dispatch through the TestHarness so we do not retain a pre-reload Worker
    // stub. After the instance starts, reacquire both the Worker and Workflow
    // introspector from the current Miniflare generation before inspecting it.
    const response = await server.fetch("https://workflow.test/start?orderId=812", { method: "POST" });
    assert.equal(response.status, 200);
    const started = await response.json();
    assert.equal(started.orderId, "812");

    const inspectionWorker = server.getWorker("cloudfault-workflow-retry");
    const workflow = await inspectionWorker.introspectWorkflow("ORDER_FLOW");
    try {
      const instances = await workflow.get();
      assert.equal(instances.length, 1);
      const [instance] = instances;
      await instance.waitForStatus("complete");
      return await instance.getOutput();
    } finally {
      await workflow.dispose();
    }
  } finally {
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
