import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyWorkflowScenario, workflowStepRetry } from "@cloudfault/cloudflare";

async function run(perturbations) {
  const workflow = await introspectWorkflow(env.ORDER_FLOW);
  try {
    await applyWorkflowScenario(workflow, { perturbations }, {
      target: "ORDER_FLOW",
      disableRetryDelays: true,
    });

    await env.ORDER_FLOW.create({ params: { orderId: "812" } });
    const instances = await workflow.get();
    expect(instances).toHaveLength(1);
    const [instance] = instances;
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
    return await instance.getOutput();
  } finally {
    await workflow.dispose();
  }
}

describe("CloudFault Workflow retry semantics in the Workers runtime", () => {
  it("completes the baseline on first attempts", async () => {
    expect(await run([])).toEqual({
      orderId: "812",
      charged: true,
      chargeAttempt: 1,
      fulfilled: true,
      fulfillmentAttempt: 1,
    });
  });

  it("injects one charge-step failure and converges after the real Workflow retry", async () => {
    const output = await run([workflowStepRetry("ORDER_FLOW", "charge")]);
    expect(output).toEqual({
      orderId: "812",
      charged: true,
      chargeAttempt: 2,
      fulfilled: true,
      fulfillmentAttempt: 1,
    });
  });
});
