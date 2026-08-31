import { WorkerEntrypoint } from "cloudflare:workers";

let charges = [];
let idempotency = new Map();
let sequence = 0;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function json(value, status = 200) { return Response.json(value, { status }); }

export default class PaymentWorker extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/charge") return json({ error: "not found" }, 404);
    const key = request.headers.get("idempotency-key");
    if (key && idempotency.has(key)) return json(idempotency.get(key));

    const input = await request.json();
    const charge = {
      id: `pay_cf_${++sequence}`,
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      idempotencyKey: key,
      committedAt: Date.now(),
    };
    charges.push(charge);
    if (key) idempotency.set(key, charge);
    return json(charge);
  }

  snapshot() { return { charges: clone(charges), idempotencyKeys: [...idempotency.keys()] }; }
  reset() { charges = []; idempotency = new Map(); sequence = 0; }
}
