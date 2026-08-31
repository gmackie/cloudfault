function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

async function callPayment(env, orderId, attempt) {
  // This fixture is intentionally buggy: every retry invents a fresh idempotency
  // key. CloudFault should prove why that is unsafe after an ambiguous outcome.
  const idempotencyKey = `${orderId}:attempt:${attempt}:${crypto.randomUUID()}`;
  const response = await env.PAYMENTS.fetch(new Request("https://payments.internal/charge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ orderId, amount: 4200, currency: "usd" }),
  }));
  if (!response.ok) throw new Error(`payment returned ${response.status}`);
  return response.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\/orders\/([^/]+)\/checkout$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return json({ error: "not found" }, { status: 404 });

    const orderId = decodeURIComponent(match[1]);
    const stateKey = `order:${orderId}`;
    const observed = await env.ORDER_STATE.get(stateKey);
    if (observed === "PAID") return json({ orderId, status: "already_paid", charged: false });

    let payment;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        payment = await callPayment(env, orderId, attempt);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!payment) return json({ error: "payment_failed", detail: String(lastError) }, { status: 502 });

    await env.DB.prepare(`
      INSERT INTO orders (id, status, payment_id, updated_at)
      VALUES (?, 'PAID', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'PAID', payment_id = excluded.payment_id, updated_at = excluded.updated_at
    `).bind(orderId, payment.id, Date.now()).run();

    await env.ORDER_STATE.put(stateKey, "PAID");
    await env.FULFILLMENT.send({ orderId, paymentId: payment.id });

    return json({ orderId, status: "paid", charged: true, paymentId: payment.id });
  },
};
