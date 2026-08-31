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
    // The introspector installs Workflow test hooks by reloading Miniflare.
    // A WorkerHandle acquired before that reload is intentionally invalidated,
    // so only use the initial handle to create the introspector. Dispatch the
    // application request through the TestHarness itself after modifiers land.
    const controllerWorker = server.getWorker("cloudfault-workflow-retry");
    const workflow = await controllerWorker.introspectWorkflow("ORDER_FLOW");
    try {
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
