import type { SemanticAdapter } from "@cloudfault/adapter-sdk";
import { firstPartyAdapters } from "./catalog.js";

export type SemanticsMaturity = "classifier" | "semantic" | "stateful" | "conformant";

export interface SemanticsEvidence {
  kind: "provider-contract" | "provider-docs" | "behavioral-test" | "community";
  source: string;
  version?: string;
  checkedAt?: string;
  notes?: string;
}

export interface ProviderSemanticsRecord {
  adapter: string;
  provider: string;
  adapterVersion?: string;
  contractVersion?: string;
  maturity: SemanticsMaturity;
  capabilities: readonly string[];
  hosts: readonly string[];
  unofficial: boolean;
  evidence: readonly SemanticsEvidence[];
}

const CONFORMANT = new Set(["stripe"]);

/**
 * Evidence records are deliberately explicit about their granularity. Most of
 * the bundled V0 adapters are semantic classifiers authored from providers'
 * public contracts, not claims of full endpoint emulation or formal protocol
 * conformance. Conformance is promoted only when the modeled subset has both a
 * provider-neutral adapter conformance suite and an executable runtime/backend
 * witness.
 */
function record(adapter: SemanticAdapter): ProviderSemanticsRecord {
  const conformant = CONFORMANT.has(adapter.manifest.name);
  const maturity: SemanticsMaturity = conformant ? "conformant" : "semantic";
  const evidence: SemanticsEvidence[] = [{
    kind: "provider-contract",
    source: "provider public API/documentation contract",
    version: adapter.manifest.contractVersion,
    checkedAt: "2026-08-31",
    notes: conformant
      ? "Modeled subset is additionally covered by adapter conformance and runtime behavioral tests."
      : "Semantic classifier/fault-space coverage; not a complete provider emulator.",
  }];
  if (conformant) {
    evidence.push(
      {
        kind: "behavioral-test",
        source: "test/stripe-conformance.test.mjs",
        checkedAt: "2026-08-31",
        notes: "Deterministic operation classification, retry/idempotency semantics, and fault-space contract checks.",
      },
      {
        kind: "behavioral-test",
        source: "examples/outbound-stripe-vitest/test/stripe.test.js",
        checkedAt: "2026-08-31",
        notes: "Workers-runtime ambiguous commit and stable Idempotency-Key behavior backed by StripeMemoryBackend through @msw/cloudflare.",
      },
    );
  }
  return {
    adapter: adapter.manifest.name,
    provider: adapter.manifest.provider,
    adapterVersion: adapter.manifest.version,
    contractVersion: adapter.manifest.contractVersion,
    maturity,
    capabilities: adapter.manifest.capabilities,
    hosts: adapter.manifest.hosts,
    unofficial: adapter.manifest.unofficial ?? true,
    evidence,
  };
}

export const providerSemanticsRegistry: readonly ProviderSemanticsRecord[] = firstPartyAdapters.map(record);

export function providerSemantics(name: string): ProviderSemanticsRecord | undefined {
  return providerSemanticsRegistry.find((item) => item.adapter === name);
}

export function semanticsByCapability(capability: string): readonly ProviderSemanticsRecord[] {
  return providerSemanticsRegistry.filter((item) => item.capabilities.includes(capability));
}

export function semanticsRegistryJson(): string {
  return `${JSON.stringify({
    schema: "cloudfault.provider-semantics-registry",
    version: 1,
    generatedAt: "2026-08-31",
    providers: providerSemanticsRegistry,
  }, null, 2)}\n`;
}
