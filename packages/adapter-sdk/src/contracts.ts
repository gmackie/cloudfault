import type { SemanticAdapter, SemanticOperation } from "./index.js";
import { runAdapterConformance, type AdapterConformanceCase, type AdapterContractEvidence } from "./conformance.js";

export interface SemanticContractOperation {
  name: string;
  effect: SemanticOperation["effect"];
  retry: SemanticOperation["retry"];
  faultKinds: readonly string[];
}

export interface SemanticContractSnapshot {
  schema: "cloudfault.semantic-contract";
  version: 1;
  adapter: string;
  provider: string;
  adapterVersion?: string;
  contractVersion?: string;
  hosts: readonly string[];
  capabilities: readonly string[];
  operations: readonly SemanticContractOperation[];
  evidence: readonly AdapterContractEvidence[];
  conformanceValid: boolean;
  fingerprint: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Small deterministic FNV-1a fingerprint: identity/version tracking, not cryptographic signing. */
export function semanticContractFingerprint(value: Omit<SemanticContractSnapshot, "fingerprint"> | unknown): string {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

export function snapshotSemanticContract(
  adapter: SemanticAdapter,
  cases: readonly AdapterConformanceCase[],
  evidence: readonly AdapterContractEvidence[] = [],
): SemanticContractSnapshot {
  const conformance = runAdapterConformance(adapter, cases);
  const operations = new Map<string, SemanticContractOperation>();
  for (const testCase of cases) {
    const request = typeof testCase.request === "function" ? testCase.request() : testCase.request.clone();
    const match = adapter.match(request);
    if (!match) continue;
    const faults = adapter.faultSpace(match.operation, request);
    const existing = operations.get(match.operation.name);
    const faultKinds = [...new Set([...(existing?.faultKinds ?? []), ...faults.map((item) => item.kind)])].sort();
    operations.set(match.operation.name, { name: match.operation.name, effect: match.operation.effect, retry: match.operation.retry, faultKinds });
  }
  const base = {
    schema: "cloudfault.semantic-contract" as const,
    version: 1 as const,
    adapter: adapter.manifest.name,
    provider: adapter.manifest.provider,
    adapterVersion: adapter.manifest.version,
    contractVersion: adapter.manifest.contractVersion,
    hosts: [...adapter.manifest.hosts].sort(),
    capabilities: [...adapter.manifest.capabilities].sort(),
    operations: [...operations.values()].sort((a, b) => a.name.localeCompare(b.name)),
    evidence: [...evidence],
    conformanceValid: conformance.valid,
  };
  return { ...base, fingerprint: semanticContractFingerprint(base) };
}

export interface SemanticContractDiff {
  breaking: readonly string[];
  additive: readonly string[];
  changed: boolean;
}

export function compareSemanticContracts(previous: SemanticContractSnapshot, next: SemanticContractSnapshot): SemanticContractDiff {
  const breaking: string[] = [];
  const additive: string[] = [];
  const before = new Map(previous.operations.map((operation) => [operation.name, operation]));
  const after = new Map(next.operations.map((operation) => [operation.name, operation]));
  for (const [name, operation] of before) {
    const current = after.get(name);
    if (!current) { breaking.push(`operation removed: ${name}`); continue; }
    if (operation.effect !== current.effect) breaking.push(`${name}: effect ${operation.effect} -> ${current.effect}`);
    if (operation.retry !== current.retry) breaking.push(`${name}: retry ${operation.retry} -> ${current.retry}`);
    for (const kind of operation.faultKinds) if (!current.faultKinds.includes(kind)) breaking.push(`${name}: fault removed: ${kind}`);
    for (const kind of current.faultKinds) if (!operation.faultKinds.includes(kind)) additive.push(`${name}: fault added: ${kind}`);
  }
  for (const name of after.keys()) if (!before.has(name)) additive.push(`operation added: ${name}`);
  for (const capability of previous.capabilities) if (!next.capabilities.includes(capability)) breaking.push(`capability removed: ${capability}`);
  for (const capability of next.capabilities) if (!previous.capabilities.includes(capability)) additive.push(`capability added: ${capability}`);
  return { breaking, additive, changed: previous.fingerprint !== next.fingerprint };
}

export interface ContractEvolutionResult extends SemanticContractDiff {
  valid: boolean;
  message?: string;
}

export function validateContractEvolution(previous: SemanticContractSnapshot, next: SemanticContractSnapshot): ContractEvolutionResult {
  if (previous.adapter !== next.adapter) return { valid: false, changed: true, breaking: ["adapter identity changed"], additive: [], message: "Cannot compare different adapters" };
  const diff = compareSemanticContracts(previous, next);
  const valid = !diff.breaking.length || previous.contractVersion !== next.contractVersion;
  return {
    ...diff,
    valid,
    message: valid ? undefined : `Breaking semantic changes require a contractVersion change (still '${next.contractVersion ?? "<unset>"}')`,
  };
}

export class SemanticContractRegistry {
  readonly #snapshots = new Map<string, SemanticContractSnapshot[]>();
  add(snapshot: SemanticContractSnapshot): this {
    const versions = this.#snapshots.get(snapshot.adapter) ?? [];
    if (!versions.some((item) => item.fingerprint === snapshot.fingerprint)) versions.push(snapshot);
    this.#snapshots.set(snapshot.adapter, versions);
    return this;
  }
  latest(adapter: string): SemanticContractSnapshot | undefined { return this.#snapshots.get(adapter)?.at(-1); }
  history(adapter: string): readonly SemanticContractSnapshot[] { return [...(this.#snapshots.get(adapter) ?? [])]; }
  list(): readonly string[] { return [...this.#snapshots.keys()].sort(); }
}
