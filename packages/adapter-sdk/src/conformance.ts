import type { Perturbation } from "@cloudfault/core";
import type { SemanticAdapter, SemanticOperation } from "./index.js";

export type AdapterMaturity = "classifier" | "semantic" | "stateful" | "conformant";

export interface AdapterContractEvidence {
  source: string;
  version?: string;
  checkedAt?: string;
  notes?: string;
}

export interface AdapterMaturityMetadata {
  maturity: AdapterMaturity;
  statefulBackend?: boolean;
  conformanceSuite?: string;
  evidence?: readonly AdapterContractEvidence[];
}

export interface AdapterConformanceCase {
  name: string;
  request: Request | (() => Request);
  expected?: {
    operation?: string;
    effect?: SemanticOperation["effect"];
    retry?: SemanticOperation["retry"];
    resource?: string;
    faultKinds?: readonly string[];
  };
}

export interface AdapterConformanceCheck {
  case: string;
  valid: boolean;
  message?: string;
}

export interface AdapterConformanceResult {
  adapter: string;
  valid: boolean;
  checks: readonly AdapterConformanceCheck[];
  coverage: {
    cases: number;
    matched: number;
    semanticCases: number;
    faultKinds: readonly string[];
  };
}

function requestFor(testCase: AdapterConformanceCase): Request {
  return typeof testCase.request === "function" ? testCase.request() : testCase.request.clone();
}

function checkExpected(
  testCase: AdapterConformanceCase,
  operation: SemanticOperation,
  faults: readonly Perturbation[],
): readonly AdapterConformanceCheck[] {
  const expected = testCase.expected;
  if (!expected) return [];
  const checks: AdapterConformanceCheck[] = [];
  const assert = (label: string, valid: boolean, message: string) => checks.push({
    case: `${testCase.name}:${label}`,
    valid,
    message: valid ? undefined : message,
  });

  if (expected.operation !== undefined) assert("operation", operation.name === expected.operation, `expected ${expected.operation}, got ${operation.name}`);
  if (expected.effect !== undefined) assert("effect", operation.effect === expected.effect, `expected ${expected.effect}, got ${operation.effect}`);
  if (expected.retry !== undefined) assert("retry", operation.retry === expected.retry, `expected ${expected.retry}, got ${operation.retry}`);
  if (expected.resource !== undefined) assert("resource", operation.resource === expected.resource, `expected ${expected.resource}, got ${operation.resource ?? "<none>"}`);
  for (const kind of expected.faultKinds ?? []) {
    assert(`fault:${kind}`, faults.some((item) => item.kind === kind), `fault space does not contain '${kind}'`);
  }
  return checks;
}

/**
 * Provider-neutral adapter conformance runner. It verifies deterministic
 * classification, expected semantic metadata, and basic safety rules around
 * fault spaces. Provider packs can add their own cases without depending on a
 * particular test framework.
 */
export function runAdapterConformance(
  adapter: SemanticAdapter,
  cases: readonly AdapterConformanceCase[],
): AdapterConformanceResult {
  const checks: AdapterConformanceCheck[] = [];
  const kinds = new Set<string>();
  let matched = 0;
  let semanticCases = 0;

  if (!adapter.manifest.name.trim()) checks.push({ case: "manifest:name", valid: false, message: "adapter name is empty" });
  if (!adapter.manifest.hosts.length) checks.push({ case: "manifest:hosts", valid: false, message: "adapter declares no hosts" });
  if (!adapter.manifest.capabilities.length) checks.push({ case: "manifest:capabilities", valid: false, message: "adapter declares no capabilities" });

  for (const testCase of cases) {
    const first = adapter.match(requestFor(testCase));
    const second = adapter.match(requestFor(testCase));
    const deterministic = JSON.stringify(first) === JSON.stringify(second);
    checks.push({
      case: `${testCase.name}:deterministic`,
      valid: deterministic,
      message: deterministic ? undefined : "classification changed between identical requests",
    });

    if (!first) {
      checks.push({ case: `${testCase.name}:matched`, valid: false, message: "adapter did not match request" });
      continue;
    }
    matched++;
    semanticCases++;
    const faults = adapter.faultSpace(first.operation, requestFor(testCase));
    faults.forEach((item) => kinds.add(item.kind));
    checks.push(...checkExpected(testCase, first.operation, faults));

    const duplicateIds = faults.length !== new Set(faults.map((item) => item.id)).size;
    checks.push({
      case: `${testCase.name}:unique-fault-ids`,
      valid: !duplicateIds,
      message: duplicateIds ? "fault space contains duplicate perturbation IDs" : undefined,
    });

    if (first.operation.effect === "query") {
      const unsafeCommit = faults.some((item) => "actualOutcome" in item && item.actualOutcome === "committed" && item.kind.startsWith("commit-then"));
      checks.push({
        case: `${testCase.name}:query-no-commit-fault`,
        valid: !unsafeCommit,
        message: unsafeCommit ? "query operation exposes a commit-then-* mutation fault" : undefined,
      });
    }
  }

  return {
    adapter: adapter.manifest.name,
    valid: checks.every((check) => check.valid),
    checks,
    coverage: { cases: cases.length, matched, semanticCases, faultKinds: [...kinds].sort() },
  };
}

export function inferAdapterMaturity(
  adapter: SemanticAdapter,
  options: {
    statefulBackend?: boolean;
    conformance?: AdapterConformanceResult;
  } = {},
): AdapterMaturity {
  if (options.conformance?.valid) return "conformant";
  if (options.statefulBackend) return "stateful";
  const synthetic = new Request(`https://${adapter.manifest.hosts.find((host) => !host.startsWith("*.")) ?? "example.invalid"}/`);
  const match = adapter.match(synthetic);
  if (match && adapter.faultSpace(match.operation, synthetic).length) return "semantic";
  return "classifier";
}

export function assertAdapterConformant(result: AdapterConformanceResult): void {
  if (result.valid) return;
  const failures = result.checks.filter((check) => !check.valid).map((check) => `${check.case}: ${check.message ?? "failed"}`);
  throw new Error(`Adapter '${result.adapter}' failed conformance:\n${failures.join("\n")}`);
}
