import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookSigner } from "@cloudfault/adapter-sdk/capabilities";

function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function hmacBase64(secret: string | Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64");
}

function hmacSha1Base64(secret: string, value: string): string {
  return createHmac("sha1", secret).update(value).digest("base64");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function stripeWebhookSigner(secret: string): WebhookSigner {
  return {
    headers(body, timestamp = Math.floor(Date.now() / 1000)) {
      const signature = hmacHex(secret, `${timestamp}.${body}`);
      return { "stripe-signature": `t=${timestamp},v1=${signature}` };
    },
  };
}

export function verifyStripeWebhookSignature(
  body: string,
  header: string | null,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header) return false;
  const fields = Object.fromEntries(header.split(",").map((part) => part.split("=", 2) as [string, string]));
  const timestamp = Number(fields.t);
  const signature = fields.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  return safeEqual(signature, hmacHex(secret, `${timestamp}.${body}`));
}

export function githubWebhookSigner(secret: string): WebhookSigner {
  return {
    headers(body) {
      return { "x-hub-signature-256": `sha256=${hmacHex(secret, body)}` };
    },
  };
}

export function verifyGithubWebhookSignature(body: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header, `sha256=${hmacHex(secret, body)}`);
}

export function slackWebhookSigner(secret: string): WebhookSigner {
  return {
    headers(body, timestamp = Math.floor(Date.now() / 1000)) {
      const base = `v0:${timestamp}:${body}`;
      return {
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": `v0=${hmacHex(secret, base)}`,
      };
    },
  };
}

export function verifySlackSignature(
  body: string,
  headers: Headers,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const timestampText = headers.get("x-slack-request-timestamp");
  const received = headers.get("x-slack-signature");
  if (!timestampText || !received) return false;
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  return safeEqual(received, `v0=${hmacHex(secret, `v0:${timestamp}:${body}`)}`);
}

export function shopifyWebhookSigner(secret: string): WebhookSigner {
  return {
    headers(body) {
      return { "x-shopify-hmac-sha256": hmacBase64(secret, body) };
    },
  };
}

export function verifyShopifyWebhookSignature(body: string, header: string | null, secret: string): boolean {
  return Boolean(header && safeEqual(header, hmacBase64(secret, body)));
}

/**
 * Common Svix signing format used by Resend and other SaaS webhook products.
 * The caller supplies the message id because it is part of the signature base.
 */
export function svixWebhookSigner(secret: string, messageId: string): WebhookSigner {
  const normalized = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret);
  return {
    headers(body, timestamp = Math.floor(Date.now() / 1000)) {
      const signature = hmacBase64(normalized, `${messageId}.${timestamp}.${body}`);
      return {
        "svix-id": messageId,
        "svix-timestamp": String(timestamp),
        "svix-signature": `v1,${signature}`,
      };
    },
  };
}

export function verifySvixWebhookSignature(
  body: string,
  headers: Headers,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const id = headers.get("svix-id");
  const timestampText = headers.get("svix-timestamp");
  const received = headers.get("svix-signature");
  if (!id || !timestampText || !received) return false;
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const normalized = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret);
  const expected = hmacBase64(normalized, `${id}.${timestamp}.${body}`);
  return received.split(/\s+/).some((candidate) => {
    const [version, signature] = candidate.split(",", 2);
    return version === "v1" && Boolean(signature) && safeEqual(signature!, expected);
  });
}

export function resendWebhookSigner(secret: string, messageId: string): WebhookSigner {
  return svixWebhookSigner(secret, messageId);
}

export function verifyResendWebhookSignature(
  body: string,
  headers: Headers,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  return verifySvixWebhookSignature(body, headers, secret, options);
}

export type TwilioFormParams = Readonly<Record<string, string | readonly string[]>>;

export function twilioSignatureBase(url: string, params: TwilioFormParams = {}): string {
  let value = url;
  for (const key of Object.keys(params).sort()) {
    const raw = params[key]!;
    const values = Array.isArray(raw) ? [...raw].sort() : [raw];
    for (const item of values) value += `${key}${item}`;
  }
  return value;
}

/** Twilio form webhook signer using exact URL + sorted POST parameters + HMAC-SHA1. */
export function twilioWebhookSigner(authToken: string, url: string, params: TwilioFormParams = {}): WebhookSigner {
  return {
    headers() {
      return { "x-twilio-signature": hmacSha1Base64(authToken, twilioSignatureBase(url, params)) };
    },
  };
}

export function verifyTwilioWebhookSignature(
  signature: string | null,
  authToken: string,
  url: string,
  params: TwilioFormParams = {},
): boolean {
  return Boolean(signature && safeEqual(signature, hmacSha1Base64(authToken, twilioSignatureBase(url, params))));
}
