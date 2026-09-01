import { snapshotSemanticContract, type AdapterConformanceCase, type SemanticContractSnapshot } from "@cloudfault/adapter-sdk/contracts";
import { providerSemantics } from "./registry.js";
import { semanticAdapter } from "./semantics.js";

interface ContractFixture {
  adapter: string;
  cases: readonly AdapterConformanceCase[];
}

const fixture = (adapter: string, cases: readonly AdapterConformanceCase[]): ContractFixture => ({ adapter, cases });
const request = (url: string, method = "POST", headers?: HeadersInit) => () => new Request(url, { method, headers });

export const bundledContractFixtures: readonly ContractFixture[] = [
  fixture("stripe", [{ name: "confirm", request: request("https://api.stripe.com/v1/payment_intents/pi_test/confirm", "POST", { "Idempotency-Key": "order-1" }), expected: { operation: "payment.confirm", effect: "external-side-effect", faultKinds: ["commit-then-timeout"] } }]),
  fixture("github", [{ name: "issue-create", request: request("https://api.github.com/repos/o/r/issues"), expected: { operation: "issue.create", effect: "external-side-effect", faultKinds: ["github-secondary-rate-limit"] } }]),
  fixture("openai", [{ name: "response-create", request: request("https://api.openai.com/v1/responses"), expected: { operation: "response.create", effect: "external-side-effect", faultKinds: ["stream-interrupt", "openai-long-request-timeout"] } }]),
  fixture("anthropic", [{ name: "message-create", request: request("https://api.anthropic.com/v1/messages"), expected: { operation: "message.create", effect: "external-side-effect", faultKinds: ["stream-interrupt", "anthropic-overloaded"] } }]),
  fixture("slack", [{ name: "message-post", request: request("https://slack.com/api/chat.postMessage"), expected: { operation: "message.post", effect: "external-side-effect", faultKinds: ["slack-application-error"] } }]),
  fixture("google", [{ name: "drive-read", request: request("https://www.googleapis.com/drive/v3/files/a", "GET"), expected: { operation: "google.query", effect: "query", faultKinds: ["token-expired", "token-revoked"] } }]),
  fixture("aws", [{ name: "regional-mutation", request: request("https://s3.us-east-1.amazonaws.com/bucket/key", "PUT"), expected: { operation: "aws.resource.mutate", effect: "mutation", faultKinds: ["region-unavailable"] } }]),
  fixture("twilio", [{ name: "message-send", request: request("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"), expected: { operation: "message.send", effect: "external-side-effect" } }]),
  fixture("resend", [{ name: "email-send", request: request("https://api.resend.com/emails", "POST", { "Idempotency-Key": "notice-1" }), expected: { operation: "email.send", effect: "external-side-effect" } }]),
  fixture("paypal", [{ name: "order-capture", request: request("https://api-m.sandbox.paypal.com/v2/checkout/orders/O123/capture", "POST", { "PayPal-Request-Id": "order-1" }), expected: { operation: "order.capture", effect: "external-side-effect", resource: "O123" } }]),
  fixture("shopify", [{ name: "graphql", request: request("https://store.myshopify.com/admin/api/2026-10/graphql.json"), expected: { operation: "graphql.execute", effect: "mutation", faultKinds: ["shopify-graphql-throttled"] } }]),
  fixture("vercel", [{ name: "deployment-create", request: request("https://api.vercel.com/v13/deployments"), expected: { operation: "deployment.create", effect: "async-side-effect" } }]),
];

export function bundledSemanticContracts(): readonly SemanticContractSnapshot[] {
  return bundledContractFixtures.map(({ adapter: name, cases }) => {
    const adapter = semanticAdapter(name);
    if (!adapter) throw new Error(`Bundled contract fixture references missing adapter '${name}'`);
    const record = providerSemantics(name);
    const evidence = (record?.evidence ?? []).map((item) => ({ source: item.source, version: item.version, checkedAt: item.checkedAt, notes: item.notes }));
    return snapshotSemanticContract(adapter, cases, evidence);
  });
}

export function bundledSemanticContract(name: string): SemanticContractSnapshot | undefined {
  return bundledSemanticContracts().find((contract) => contract.adapter === name);
}

export function semanticContractsJson(): string {
  return `${JSON.stringify({ schema: "cloudfault.semantic-contract-registry", version: 1, generatedAt: "2026-09-01", contracts: bundledSemanticContracts() }, null, 2)}\n`;
}
