import {
  AdapterRegistry,
  defineRulesAdapter,
  type AdapterManifest,
  type AdapterRule,
  type OperationEffect,
  type SemanticAdapter,
} from "@cloudfault/adapter-sdk";
import { stripeAdapter } from "@cloudfault/stripe";

function manifest(
  name: string,
  provider: string,
  hosts: readonly string[],
  capabilities: readonly string[],
  contractVersion = "2026-08",
): AdapterManifest {
  return {
    name,
    provider,
    version: "0.1.0",
    contractVersion,
    unofficial: true,
    hosts,
    capabilities,
  };
}

function rule(
  methods: readonly string[],
  path: RegExp | string,
  name: string,
  effect: OperationEffect,
  options: Partial<Omit<AdapterRule, "methods" | "path" | "name" | "effect">> = {},
): AdapterRule {
  return { methods, path, name, effect, ...options };
}

function idFromMatch(_request: Request, match: RegExpMatchArray | null): string | undefined {
  return match?.[1];
}

const CRUD_FALLBACK = { queryName: "query", mutationName: "mutation", mutationEffect: "mutation" as const };

export const githubAdapter = defineRulesAdapter({
  manifest: manifest("github", "GitHub", ["api.github.com"], ["rest", "graphql", "rate-limits", "webhooks", "idempotency-risk"]),
  rules: [
    rule(["POST"], /^\/repos\/[^/]+\/[^/]+\/issues$/, "issue.create", "external-side-effect"),
    rule(["POST"], /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, "issue.comment.create", "external-side-effect"),
    rule(["POST"], /^\/repos\/[^/]+\/[^/]+\/pulls$/, "pull_request.create", "external-side-effect"),
    rule(["POST"], "/graphql", "graphql.execute", "mutation"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "github.query", mutationName: "github.mutation" },
});

export const openaiAdapter = defineRulesAdapter({
  manifest: manifest("openai", "OpenAI", ["api.openai.com"], ["rest", "streaming", "rate-limits", "async-jobs", "usage-side-effects"]),
  rules: [
    rule(["POST"], "/v1/responses", "response.create", "external-side-effect", { idempotencyHeader: "Idempotency-Key" }),
    rule(["POST"], "/v1/chat/completions", "chat_completion.create", "external-side-effect", { idempotencyHeader: "Idempotency-Key" }),
    rule(["POST"], "/v1/embeddings", "embedding.create", "external-side-effect"),
    rule(["POST"], /^\/v1\/batches(?:\/|$)/, "batch.mutate", "async-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "openai.query", mutationName: "openai.mutation" },
});

export const anthropicAdapter = defineRulesAdapter({
  manifest: manifest("anthropic", "Anthropic", ["api.anthropic.com"], ["rest", "streaming", "rate-limits", "usage-side-effects"]),
  rules: [
    rule(["POST"], "/v1/messages", "message.create", "external-side-effect"),
    rule(["POST"], /^\/v1\/messages\/batches(?:\/|$)/, "message_batch.mutate", "async-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "anthropic.query", mutationName: "anthropic.mutation" },
});

export const slackAdapter = defineRulesAdapter({
  manifest: manifest("slack", "Slack", ["slack.com"], ["web-api", "rate-limits", "messages", "webhooks"]),
  rules: [
    rule(["POST"], "/api/chat.postMessage", "message.post", "external-side-effect"),
    rule(["POST"], "/api/chat.update", "message.update", "external-side-effect"),
    rule(["POST"], "/api/files.upload", "file.upload", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "slack.query", mutationName: "slack.mutation" },
});

export const googleAdapter = defineRulesAdapter({
  manifest: manifest("google", "Google Workspace", [
    "www.googleapis.com",
    "gmail.googleapis.com",
    "calendar.googleapis.com",
    "people.googleapis.com",
    "drive.googleapis.com",
  ], ["oauth", "gmail", "calendar", "drive", "rate-limits", "pagination"]),
  rules: [
    rule(["POST"], /^\/gmail\/v1\/users\/[^/]+\/messages\/send$/, "gmail.message.send", "external-side-effect"),
    rule(["POST"], /^\/calendar\/v3\/calendars\/[^/]+\/events$/, "calendar.event.create", "external-side-effect"),
    rule(["POST", "PATCH", "PUT", "DELETE"], /^\/drive\/v3\/files(?:\/|$)/, "drive.file.mutate", "mutation"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "google.query", mutationName: "google.mutation" },
});

export const microsoftGraphAdapter = defineRulesAdapter({
  manifest: manifest("microsoft-graph", "Microsoft Graph", ["graph.microsoft.com"], ["oauth", "graph", "mail", "calendar", "rate-limits", "pagination"]),
  rules: [
    rule(["POST"], /^\/v1\.0\/.*\/sendMail$/, "mail.send", "external-side-effect"),
    rule(["POST"], /^\/v1\.0\/.*\/events$/, "calendar.event.create", "external-side-effect"),
    rule(["POST", "PATCH", "PUT", "DELETE"], /^\/v1\.0\//, "graph.mutate", "mutation"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "graph.query", mutationName: "graph.mutation" },
});

export const awsAdapter = defineRulesAdapter({
  manifest: manifest("aws", "Amazon Web Services", ["*.amazonaws.com"], ["sigv4", "s3", "sqs", "ses", "sts", "throttling", "regional-failures"]),
  rules: [
    rule(["POST"], /^\/$/, "aws.action", "mutation"),
    rule(["PUT", "POST", "DELETE"], /.*/, "aws.resource.mutate", "mutation"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "aws.query", mutationName: "aws.mutation" },
});

export const twilioAdapter = defineRulesAdapter({
  manifest: manifest("twilio", "Twilio", ["api.twilio.com"], ["sms", "voice", "verify", "callbacks", "rate-limits"]),
  rules: [
    rule(["POST"], /^\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/, "message.send", "external-side-effect"),
    rule(["POST"], /^\/2010-04-01\/Accounts\/[^/]+\/Calls\.json$/, "call.create", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "twilio.query", mutationName: "twilio.mutation" },
});

export const sendgridAdapter = defineRulesAdapter({
  manifest: manifest("sendgrid", "SendGrid", ["api.sendgrid.com"], ["email", "webhooks", "rate-limits"]),
  rules: [rule(["POST"], "/v3/mail/send", "mail.send", "external-side-effect")],
  fallback: { ...CRUD_FALLBACK, queryName: "sendgrid.query", mutationName: "sendgrid.mutation" },
});

export const resendAdapter = defineRulesAdapter({
  manifest: manifest("resend", "Resend", ["api.resend.com"], ["email", "webhooks", "idempotency", "rate-limits"]),
  rules: [rule(["POST"], "/emails", "email.send", "external-side-effect", { idempotencyHeader: "Idempotency-Key" })],
  fallback: { ...CRUD_FALLBACK, queryName: "resend.query", mutationName: "resend.mutation", idempotencyHeader: "Idempotency-Key" },
});

export const paypalAdapter = defineRulesAdapter({
  manifest: manifest("paypal", "PayPal", ["api-m.paypal.com", "api-m.sandbox.paypal.com"], ["payments", "idempotency", "webhooks", "rate-limits"]),
  rules: [
    rule(["POST"], "/v2/checkout/orders", "order.create", "external-side-effect", { idempotencyHeader: "PayPal-Request-Id" }),
    rule(["POST"], /^\/v2\/checkout\/orders\/([^/]+)\/capture$/, "order.capture", "external-side-effect", { idempotencyHeader: "PayPal-Request-Id", resource: idFromMatch }),
    rule(["POST"], /^\/v2\/payments\/captures\/([^/]+)\/refund$/, "refund.create", "external-side-effect", { idempotencyHeader: "PayPal-Request-Id", resource: idFromMatch }),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "paypal.query", mutationName: "paypal.mutation", idempotencyHeader: "PayPal-Request-Id" },
});

export const shopifyAdapter = defineRulesAdapter({
  manifest: manifest("shopify", "Shopify", ["*.myshopify.com"], ["admin-api", "graphql", "webhooks", "rate-limits", "commerce"]),
  rules: [
    rule(["POST"], /^\/admin\/api\/[^/]+\/orders\.json$/, "order.create", "external-side-effect"),
    rule(["POST"], /^\/admin\/api\/[^/]+\/orders\/([^/]+)\/refunds\.json$/, "refund.create", "external-side-effect", { resource: idFromMatch }),
    rule(["POST"], /^\/admin\/api\/[^/]+\/graphql\.json$/, "graphql.execute", "mutation"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "shopify.query", mutationName: "shopify.mutation" },
});

export const clerkAdapter = defineRulesAdapter({
  manifest: manifest("clerk", "Clerk", ["api.clerk.com"], ["identity", "sessions", "webhooks", "rate-limits"]),
  rules: [
    rule(["POST", "PATCH", "DELETE"], /^\/v1\/users(?:\/|$)/, "user.mutate", "external-side-effect"),
    rule(["POST", "DELETE"], /^\/v1\/sessions(?:\/|$)/, "session.mutate", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "clerk.query", mutationName: "clerk.mutation" },
});

export const auth0Adapter = defineRulesAdapter({
  manifest: manifest("auth0", "Auth0", ["*.auth0.com"], ["oauth", "management-api", "identity", "rate-limits"]),
  rules: [
    rule(["POST"], "/oauth/token", "oauth.token", "external-side-effect"),
    rule(["POST", "PATCH", "DELETE"], /^\/api\/v2\/users(?:\/|$)/, "user.mutate", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "auth0.query", mutationName: "auth0.mutation" },
});

export const workosAdapter = defineRulesAdapter({
  manifest: manifest("workos", "WorkOS", ["api.workos.com"], ["sso", "directory-sync", "webhooks", "identity", "rate-limits"]),
  rules: [
    rule(["POST"], /^\/user_management\/users(?:\/|$)/, "user.mutate", "external-side-effect"),
    rule(["POST"], /^\/sso\/authorize(?:\/|$)/, "sso.authorize", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "workos.query", mutationName: "workos.mutation" },
});

export const oktaAdapter = defineRulesAdapter({
  manifest: manifest("okta", "Okta", ["*.okta.com"], ["oauth", "identity", "sessions", "rate-limits"]),
  rules: [
    rule(["POST", "PUT", "DELETE"], /^\/api\/v1\/users(?:\/|$)/, "user.mutate", "external-side-effect"),
    rule(["POST", "DELETE"], /^\/api\/v1\/sessions(?:\/|$)/, "session.mutate", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "okta.query", mutationName: "okta.mutation" },
});

export const supabaseAdapter = defineRulesAdapter({
  manifest: manifest("supabase", "Supabase", ["*.supabase.co"], ["postgres-rest", "auth", "storage", "realtime", "rate-limits"]),
  rules: [
    rule(["POST", "PATCH", "PUT", "DELETE"], /^\/rest\/v1\//, "database.mutate", "mutation"),
    rule(["POST", "PUT", "DELETE"], /^\/storage\/v1\//, "storage.mutate", "mutation"),
    rule(["POST"], /^\/auth\/v1\//, "auth.mutate", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "supabase.query", mutationName: "supabase.mutation" },
});

export const firebaseAdapter = defineRulesAdapter({
  manifest: manifest("firebase", "Firebase", ["firestore.googleapis.com", "identitytoolkit.googleapis.com", "securetoken.googleapis.com"], ["firestore", "auth", "eventual-observation", "rate-limits"]),
  rules: [
    rule(["POST", "PATCH", "DELETE"], /^\/v1\/projects\/.*\/databases\/.*\/documents(?:\/|$)/, "firestore.mutate", "mutation"),
    rule(["POST"], /^\/v1\/accounts:/, "identity.mutate", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "firebase.query", mutationName: "firebase.mutation" },
});

export const mongodbAtlasAdapter = defineRulesAdapter({
  manifest: manifest("mongodb-atlas", "MongoDB Atlas", ["cloud.mongodb.com"], ["admin-api", "async-operations", "rate-limits"]),
  rules: [
    rule(["POST", "PATCH", "DELETE"], /^\/api\/atlas\/v2\//, "atlas.resource.mutate", "async-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "atlas.query", mutationName: "atlas.mutation" },
});

export const vercelAdapter = defineRulesAdapter({
  manifest: manifest("vercel", "Vercel", ["api.vercel.com"], ["deployments", "projects", "webhooks", "rate-limits", "async-jobs"]),
  rules: [
    rule(["POST"], "/v13/deployments", "deployment.create", "async-side-effect"),
    rule(["DELETE"], /^\/v13\/deployments\/([^/]+)$/, "deployment.delete", "external-side-effect", { resource: idFromMatch }),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "vercel.query", mutationName: "vercel.mutation" },
});

export const linearAdapter = defineRulesAdapter({
  manifest: manifest("linear", "Linear", ["api.linear.app"], ["graphql", "webhooks", "rate-limits"]),
  rules: [rule(["POST"], "/graphql", "graphql.execute", "mutation")],
  fallback: { ...CRUD_FALLBACK, queryName: "linear.query", mutationName: "linear.mutation" },
});

export const discordAdapter = defineRulesAdapter({
  manifest: manifest("discord", "Discord", ["discord.com"], ["messages", "bots", "webhooks", "rate-limits"]),
  rules: [
    rule(["POST"], /^\/api\/v\d+\/channels\/([^/]+)\/messages$/, "message.create", "external-side-effect", { resource: idFromMatch }),
    rule(["POST"], /^\/api\/webhooks\//, "webhook.execute", "external-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "discord.query", mutationName: "discord.mutation" },
});

export const cloudinaryAdapter = defineRulesAdapter({
  manifest: manifest("cloudinary", "Cloudinary", ["api.cloudinary.com"], ["uploads", "assets", "transformations", "rate-limits"]),
  rules: [
    rule(["POST"], /^\/v1_1\/[^/]+\/(?:image|video|raw)\/upload$/, "asset.upload", "external-side-effect"),
    rule(["POST", "DELETE"], /^\/v1_1\/[^/]+\/resources(?:\/|$)/, "asset.mutate", "mutation"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "cloudinary.query", mutationName: "cloudinary.mutation" },
});

export const algoliaAdapter = defineRulesAdapter({
  manifest: manifest("algolia", "Algolia", ["*.algolia.net", "*.algolianet.com"], ["search", "indexing", "eventual-index-visibility", "rate-limits"]),
  rules: [
    rule(["POST"], /^\/1\/indexes\/[^/]+\/query$/, "index.query", "query"),
    rule(["POST", "PUT", "DELETE"], /^\/1\/indexes\//, "index.mutate", "async-side-effect"),
  ],
  fallback: { ...CRUD_FALLBACK, queryName: "algolia.query", mutationName: "algolia.mutation" },
});

export const firstPartyAdapters: readonly SemanticAdapter[] = [
  stripeAdapter,
  githubAdapter,
  openaiAdapter,
  anthropicAdapter,
  slackAdapter,
  googleAdapter,
  microsoftGraphAdapter,
  awsAdapter,
  twilioAdapter,
  sendgridAdapter,
  resendAdapter,
  paypalAdapter,
  shopifyAdapter,
  clerkAdapter,
  auth0Adapter,
  workosAdapter,
  oktaAdapter,
  supabaseAdapter,
  firebaseAdapter,
  mongodbAtlasAdapter,
  vercelAdapter,
  linearAdapter,
  discordAdapter,
  cloudinaryAdapter,
  algoliaAdapter,
];

export function registerFirstPartyAdapters(registry = new AdapterRegistry()): AdapterRegistry {
  return registry.registerAll(firstPartyAdapters);
}
