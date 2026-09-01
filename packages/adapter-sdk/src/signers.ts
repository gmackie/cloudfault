import type { WebhookSigner } from "./capabilities.js";

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function hex(value: ArrayBuffer): string { return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmac(secret: string, payload: string, format: "hex" | "base64" = "hex"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, bytes(payload));
  return format === "hex" ? hex(signature) : base64(signature);
}

export function stripeWebhookSigner(secret: string): WebhookSigner {
  return { async headers(body, timestamp = Math.floor(Date.now() / 1000)) { return { "Stripe-Signature": `t=${timestamp},v1=${await hmac(secret, `${timestamp}.${body}`)}` }; } };
}

export function githubWebhookSigner(secret: string): WebhookSigner {
  return { async headers(body) { return { "X-Hub-Signature-256": `sha256=${await hmac(secret, body)}` }; } };
}

export function shopifyWebhookSigner(secret: string): WebhookSigner {
  return { async headers(body) { return { "X-Shopify-Hmac-Sha256": await hmac(secret, body, "base64") }; } };
}

export function slackWebhookSigner(secret: string): WebhookSigner {
  return {
    async headers(body, timestamp = Math.floor(Date.now() / 1000)) {
      return {
        "X-Slack-Request-Timestamp": String(timestamp),
        "X-Slack-Signature": `v0=${await hmac(secret, `v0:${timestamp}:${body}`)}`,
      };
    },
  };
}
