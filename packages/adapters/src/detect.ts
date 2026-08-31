import type { SemanticAdapter } from "@cloudfault/adapter-sdk";
import { firstPartyAdapters } from "./catalog.js";

export interface AdapterEvidence {
  adapter: string;
  provider: string;
  evidence: readonly string[];
}

const PACKAGE_HINTS: Record<string, readonly string[]> = {
  stripe: ["stripe", "@stripe/stripe-js"],
  github: ["octokit", "@octokit/"],
  openai: ["openai"],
  anthropic: ["@anthropic-ai/sdk"],
  slack: ["@slack/web-api", "@slack/bolt"],
  google: ["googleapis", "google-auth-library", "@googleapis/"],
  "microsoft-graph": ["@microsoft/microsoft-graph-client", "@azure/identity"],
  aws: ["@aws-sdk/", "aws-sdk"],
  twilio: ["twilio"],
  sendgrid: ["@sendgrid/mail", "@sendgrid/client"],
  resend: ["resend"],
  paypal: ["@paypal/checkout-server-sdk", "@paypal/paypal-server-sdk"],
  shopify: ["@shopify/shopify-api", "@shopify/admin-api-client"],
  clerk: ["@clerk/backend", "@clerk/clerk-sdk-node"],
  auth0: ["auth0", "@auth0/"],
  workos: ["@workos-inc/node"],
  okta: ["@okta/okta-sdk-nodejs", "@okta/okta-auth-js"],
  supabase: ["@supabase/supabase-js"],
  firebase: ["firebase-admin", "firebase/app", "firebase/firestore"],
  "mongodb-atlas": ["mongodb", "@mongodb-js/"],
  vercel: ["@vercel/sdk", "@vercel/client"],
  linear: ["@linear/sdk"],
  discord: ["discord.js", "@discordjs/"],
  cloudinary: ["cloudinary"],
  algolia: ["algoliasearch", "@algolia/"],
};

function packageSpecifiers(source: string): readonly string[] {
  const output = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]) output.add(match[1]);
  }
  return [...output];
}

function packageMatches(specifier: string, hint: string): boolean {
  if (hint.endsWith("/")) return specifier.startsWith(hint);
  return specifier === hint || specifier.startsWith(`${hint}/`);
}

function hostEvidence(source: string, adapter: SemanticAdapter): readonly string[] {
  const evidence: string[] = [];
  for (const host of adapter.manifest.hosts) {
    const needle = host.startsWith("*.") ? host.slice(2) : host;
    if (source.includes(needle)) evidence.push(`host:${host}`);
  }
  return evidence;
}

export function detectAdaptersFromSource(source: string): readonly AdapterEvidence[] {
  const packages = packageSpecifiers(source);
  const findings: AdapterEvidence[] = [];
  for (const adapter of firstPartyAdapters) {
    const evidence = new Set<string>();
    for (const hint of PACKAGE_HINTS[adapter.manifest.name] ?? []) {
      for (const specifier of packages) {
        if (packageMatches(specifier, hint)) evidence.add(`package:${specifier}`);
      }
    }
    for (const hit of hostEvidence(source, adapter)) evidence.add(hit);
    if (evidence.size) findings.push({
      adapter: adapter.manifest.name,
      provider: adapter.manifest.provider,
      evidence: [...evidence],
    });
  }
  return findings;
}

export function mergeAdapterEvidence(findings: readonly AdapterEvidence[]): readonly AdapterEvidence[] {
  const merged = new Map<string, { provider: string; evidence: Set<string> }>();
  for (const finding of findings) {
    const entry = merged.get(finding.adapter) ?? { provider: finding.provider, evidence: new Set<string>() };
    for (const evidence of finding.evidence) entry.evidence.add(evidence);
    merged.set(finding.adapter, entry);
  }
  return [...merged]
    .map(([adapter, value]) => ({ adapter, provider: value.provider, evidence: [...value.evidence].sort() }))
    .sort((a, b) => a.adapter.localeCompare(b.adapter));
}
