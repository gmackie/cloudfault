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

const STATEFUL = new Set(["stripe"]);

/**
 * Evidence records are deliberately explicit about their granularity. Most of
 * the bundled V0 adapters are semantic classifiers authored from providers'
 * public contracts, not claims of full endpoint emulation or formal protocol
 * conformance. Stateful/conformance maturity is promoted only when executable
 * coverage exists.
 */
function record(adapter: SemanticAdapter): ProviderSemanticsRecord {
  const maturity: SemanticsMaturity = STATEFUL.has(adapter.manifest.name) ? "stateful" : "semantic";
  return {
    adapter: adapter.manifest.name,
    provider: adapter.manifest.provider,
    adapterVersion: adapter.manifest.version,
    contractVersion: adapter.manifest.contractVersion,
    maturity,
    capabilities: adapter.manifest.capabilities,
    hosts: adapter.manifest.hosts,
    unofficial: adapter.manifest.unofficial ?? true,
    evidence: [{
      kind: "provider-contract",
      source: "provider public API/documentation contract",
      version: adapter.manifest.contractVersion,
      checkedAt: "2026-08-31",
      notes: maturity === "stateful"
        ? "Semantic classifier plus executable stateful test backend for the covered subset."
        : "Semantic classifier/fault-space coverage; not a complete provider emulator.",
    }],
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
