import { snapshotSemanticContract, type SemanticContractSnapshot } from "@cloudfault/adapter-sdk/contracts";
import type { AdapterConformanceCase } from "@cloudfault/adapter-sdk/conformance";
import { providerSemantics } from "./registry.js";
import { semanticAdapter } from "./semantics.js";

interface ContractFixture {
  adapter: string;
  cases: readonly AdapterConformanceCase[];
}

const fixture = (adapter: string, cases: readonly AdapterConformanceCase[]): ContractFixture => ({ adapter, cases });
const request = (url: string, method = "POST", headers?: HeadersInit) => () => new Request(url, { method, headers });
const semanticCase = (
  name: string,
  url: string,
  expected: NonNullable<AdapterConformanceCase["expected"]>,
  method = "POST",
  headers?: HeadersInit,
): AdapterConformanceCase => ({ name, request: request(url, method, headers), expected });

export const bundledContractFixtures: readonly ContractFixture[] = [
  fixture("stripe", [semanticCase("confirm", "https://api.stripe.com/v1/payment_intents/pi_test/confirm", { operation: "payment_intent.confirm", effect: "external-side-effect", faultKinds: ["commit-then-timeout"] }, "POST", { "Idempotency-Key": "order-1" })]),
  fixture("github", [semanticCase("issue-create", "https://api.github.com/repos/o/r/issues", { operation: "issue.create", effect: "external-side-effect", faultKinds: ["github-secondary-rate-limit"] })]),
  fixture("openai", [semanticCase("response-create", "https://api.openai.com/v1/responses", { operation: "response.create", effect: "external-side-effect", faultKinds: ["stream-interrupt", "openai-long-request-timeout"] })]),
  fixture("anthropic", [semanticCase("message-create", "https://api.anthropic.com/v1/messages", { operation: "message.create", effect: "external-side-effect", faultKinds: ["stream-interrupt", "anthropic-overloaded"] })]),
  fixture("slack", [semanticCase("message-post", "https://slack.com/api/chat.postMessage", { operation: "message.post", effect: "external-side-effect", faultKinds: ["slack-application-error"] })]),
  fixture("google", [semanticCase("drive-read", "https://www.googleapis.com/drive/v3/files/a", { operation: "google.query", effect: "query", faultKinds: ["token-expired", "token-revoked"] }, "GET")]),
  fixture("microsoft-graph", [semanticCase("mail-send", "https://graph.microsoft.com/v1.0/me/sendMail", { operation: "mail.send", effect: "external-side-effect", faultKinds: ["token-expired", "token-revoked"] })]),
  fixture("aws", [semanticCase("regional-mutation", "https://s3.us-east-1.amazonaws.com/bucket/key", { operation: "aws.resource.mutate", effect: "mutation", faultKinds: ["region-unavailable"] }, "PUT")]),
  fixture("twilio", [semanticCase("message-send", "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json", { operation: "message.send", effect: "external-side-effect" })]),
  fixture("sendgrid", [semanticCase("mail-send", "https://api.sendgrid.com/v3/mail/send", { operation: "mail.send", effect: "external-side-effect" })]),
  fixture("resend", [semanticCase("email-send", "https://api.resend.com/emails", { operation: "email.send", effect: "external-side-effect" }, "POST", { "Idempotency-Key": "notice-1" })]),
  fixture("paypal", [semanticCase("order-capture", "https://api-m.sandbox.paypal.com/v2/checkout/orders/O123/capture", { operation: "order.capture", effect: "external-side-effect", resource: "O123" }, "POST", { "PayPal-Request-Id": "order-1" })]),
  fixture("shopify", [semanticCase("graphql", "https://store.myshopify.com/admin/api/2026-10/graphql.json", { operation: "graphql.execute", effect: "mutation", faultKinds: ["shopify-graphql-throttled"] })]),
  fixture("clerk", [semanticCase("user-create", "https://api.clerk.com/v1/users", { operation: "user.mutate", effect: "external-side-effect" })]),
  fixture("auth0", [semanticCase("token", "https://tenant.auth0.com/oauth/token", { operation: "oauth.token", effect: "external-side-effect", faultKinds: ["token-expired", "token-revoked"] })]),
  fixture("workos", [semanticCase("user-create", "https://api.workos.com/user_management/users", { operation: "user.mutate", effect: "external-side-effect" })]),
  fixture("okta", [semanticCase("user-create", "https://tenant.okta.com/api/v1/users", { operation: "user.mutate", effect: "external-side-effect", faultKinds: ["token-expired", "token-revoked"] })]),
  fixture("supabase", [semanticCase("database-mutate", "https://project.supabase.co/rest/v1/widgets", { operation: "database.mutate", effect: "mutation" })]),
  fixture("firebase", [semanticCase("firestore-mutate", "https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/widgets/w1", { operation: "firestore.mutate", effect: "mutation" })]),
  fixture("mongodb-atlas", [semanticCase("cluster-mutate", "https://cloud.mongodb.com/api/atlas/v2/groups/g/clusters", { operation: "atlas.resource.mutate", effect: "async-side-effect" })]),
  fixture("vercel", [semanticCase("deployment-create", "https://api.vercel.com/v13/deployments", { operation: "deployment.create", effect: "async-side-effect" })]),
  fixture("linear", [semanticCase("graphql", "https://api.linear.app/graphql", { operation: "graphql.execute", effect: "mutation" })]),
  fixture("discord", [semanticCase("message-create", "https://discord.com/api/v10/channels/123/messages", { operation: "message.create", effect: "external-side-effect", resource: "123" })]),
  fixture("cloudinary", [semanticCase("asset-upload", "https://api.cloudinary.com/v1_1/demo/image/upload", { operation: "asset.upload", effect: "external-side-effect" })]),
  fixture("algolia", [semanticCase("index-mutate", "https://abc.algolia.net/1/indexes/products/object-1", { operation: "index.mutate", effect: "async-side-effect" }, "PUT")]),
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
