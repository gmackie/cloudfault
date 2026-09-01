import test from "node:test";
import assert from "node:assert/strict";
import {
  resendWebhookSigner,
  twilioSignatureBase,
  twilioWebhookSigner,
  verifyResendWebhookSignature,
  verifyTwilioWebhookSignature,
} from "../packages/adapters/dist/index.js";

test("Twilio signer matches the documented HMAC-SHA1 form example", async () => {
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
    To: "+18005551212",
  };
  assert.equal(
    twilioSignatureBase(url, params),
    "https://example.com/myapp.php?foo=1&bar=2CallSidCA1234567890ABCDECaller+14158675310Digits1234From+14158675310To+18005551212",
  );
  const headers = await twilioWebhookSigner("12345", url, params).headers("");
  assert.equal(headers["x-twilio-signature"], "L/OH5YylLD5NRKLltdqwSvS0BnU=");
  assert.equal(verifyTwilioWebhookSignature(headers["x-twilio-signature"], "12345", url, params), true);
  assert.equal(verifyTwilioWebhookSignature(headers["x-twilio-signature"], "wrong", url, params), false);
});

test("Resend Svix-compatible signer emits and verifies the three required headers", async () => {
  const secret = `whsec_${Buffer.from("cloudfault-resend-test-secret").toString("base64")}`;
  const body = JSON.stringify({ type: "email.sent", data: { email_id: "email_1" } });
  const signed = await resendWebhookSigner(secret, "msg_123").headers(body, 1_777_777_777);
  const headers = new Headers(signed);
  assert.equal(headers.get("svix-id"), "msg_123");
  assert.equal(headers.get("svix-timestamp"), "1777777777");
  assert.match(headers.get("svix-signature") ?? "", /^v1,/);
  assert.equal(verifyResendWebhookSignature(body, headers, secret, { now: 1_777_777_777 }), true);
  assert.equal(verifyResendWebhookSignature(`${body} `, headers, secret, { now: 1_777_777_777 }), false);
});
