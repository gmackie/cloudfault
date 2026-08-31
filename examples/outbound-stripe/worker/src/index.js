function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

async function createAndConfirm(orderId, attempt, stableKey) {
  const body = new URLSearchParams({
    amount: "4200",
    currency: "usd",
    confirm: "true",
    metadata_order_id: orderId,
  });
  const idempotencyKey = stableKey
    ? `order:${orderId}:payment`
    : `order:${orderId}:attempt:${attempt}:${crypto.randomUUID()}`;

  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test_cloudfault",
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": idempotencyKey,
    },
    body,
  });
  if (!response.ok) throw new Error(`Stripe returned ${response.status}`);
  return response.json();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = /^\/orders\/([^/]+)\/pay$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return json({ error: "not found" }, { status: 404 });

    const orderId = decodeURIComponent(match[1]);
    const stableKey = request.headers.get("x-cloudfault-stable-idempotency") === "1"
      || url.searchParams.get("stableKey") === "1";
    let payment;
    let lastError;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        payment = await createAndConfirm(orderId, attempt, stableKey);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!payment) {
      return json({ error: "payment_failed", detail: String(lastError), stableKey }, { status: 502 });
    }

    return json({ orderId, paymentId: payment.id, charged: true, stableKey });
  },
};
