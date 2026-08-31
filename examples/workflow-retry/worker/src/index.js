import { WorkflowEntrypoint } from "cloudflare:workers";

export class OrderWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const charge = await step.do(
      "charge",
      {
        retries: { limit: 3, delay: "1 second", backoff: "constant" },
        timeout: "1 minute",
      },
      async (ctx) => ({
        orderId: event.payload.orderId,
        charged: true,
        attempt: ctx.attempt,
      }),
    );

    const fulfillment = await step.do("fulfill", async (ctx) => ({
      orderId: charge.orderId,
      fulfilled: true,
      attempt: ctx.attempt,
    }));

    return {
      orderId: charge.orderId,
      charged: charge.charged,
      chargeAttempt: charge.attempt,
      fulfilled: fulfillment.fulfilled,
      fulfillmentAttempt: fulfillment.attempt,
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/start") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const orderId = url.searchParams.get("orderId") ?? "812";
    const instance = await env.ORDER_FLOW.create({
      params: { orderId },
    });
    return Response.json({ id: instance.id, orderId });
  },
};
