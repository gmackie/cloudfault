import type { RunResult, ScenarioPlan } from "@cloudfault/core";

/** Statuses ForgeGraph accepts for a test run (apps/web/src/app/api/evidence). */
export type ForgeGraphTestRunStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

/** Evidence producers ForgeGraph accepts. CloudFault runs in CI, so `gitea_ci`. */
export type ForgeGraphEvidenceSource = "gitea_ci" | "veritas";

/**
 * A suite-level result before it is bound to a changeset. Every CloudFault
 * mapping produces one of these; `toTestRunEvidence` binds it.
 */
export interface EvidenceDraft {
  suiteName: string;
  status: ForgeGraphTestRunStatus;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  coveragePercent?: number;
  coverageSummary: string;
  durationMs?: number;
}

/** The `test_run` body POSTed to ForgeGraph's `/api/evidence`. */
export interface ForgeGraphTestRunEvidence extends EvidenceDraft {
  type: "test_run";
  changesetId: string;
  source: ForgeGraphEvidenceSource;
  externalRunId: string;
}

/** Binding types with a dedicated CloudFault semantic pack (mirrors `cloudfault doctor`). */
export const SUPPORTED_BINDING_TYPES: readonly string[] = [
  "kv", "d1", "r2", "queue-producer", "queue-consumer", "durable-object", "service", "workflow",
];

export interface WorkerInspection {
  /** Path of the wrangler configuration, relative to the repository root. */
  config: string;
  name?: string;
  bindings: readonly { type: string; binding: string }[];
  /** Detected external semantic adapters (e.g. "stripe"). */
  adapters: readonly string[];
}

export interface StaticCoverageOptions {
  suiteName?: string;
  supportedBindingTypes?: readonly string[];
  durationMs?: number;
}

function percent(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return undefined;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Semantic-coverage evidence from a static inspection. Each binding with a
 * CloudFault semantic pack and each detected provider adapter counts as a
 * passed check; bindings without a pack are skipped, not failed, because a
 * coverage gap is not a defect in the application. Finding no Worker at all is
 * reported as cancelled: the inspection could not run, so it has no outcome.
 */
export function staticCoverageEvidence(workers: readonly WorkerInspection[], options: StaticCoverageOptions = {}): EvidenceDraft {
  const suiteName = options.suiteName ?? "cloudfault:static";
  const supported = new Set(options.supportedBindingTypes ?? SUPPORTED_BINDING_TYPES);
  if (!workers.length) {
    return {
      suiteName,
      status: "cancelled",
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      coverageSummary: "No wrangler configuration found; nothing was inspected.",
      durationMs: options.durationMs,
    };
  }
  const bindings = workers.flatMap((worker) => worker.bindings);
  const covered = bindings.filter((binding) => supported.has(binding.type));
  const uncovered = bindings.filter((binding) => !supported.has(binding.type));
  const adapters = [...new Set(workers.flatMap((worker) => worker.adapters))].sort();
  const gaps = [...new Set(uncovered.map((binding) => binding.type))].sort();
  const summary = [
    `${workers.length} worker${workers.length === 1 ? "" : "s"}`,
    `${covered.length}/${bindings.length} bindings with semantic packs`,
    `adapters: ${adapters.join(", ") || "none"}`,
    gaps.length ? `no pack for: ${gaps.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
  return {
    suiteName,
    status: "passed",
    totalTests: bindings.length + adapters.length,
    passedTests: covered.length + adapters.length,
    failedTests: 0,
    skippedTests: uncovered.length,
    coveragePercent: percent(covered.length, bindings.length),
    coverageSummary: summary,
    durationMs: options.durationMs,
  };
}

export interface PlanEvidenceOptions {
  suiteName?: string;
  /** Why the planned scenarios were not executed. */
  reason?: string;
  durationMs?: number;
}

/**
 * Evidence for a fault plan that was computed but not executed. Every planned
 * scenario is skipped, and the run is `queued` — literally true, and the one
 * status that records the plan without telling ForgeGraph's attestation engine
 * that anything passed or failed.
 */
export function planEvidence(plan: ScenarioPlan, options: PlanEvidenceOptions = {}): EvidenceDraft {
  const reason = options.reason ?? "not executed";
  return {
    suiteName: options.suiteName ?? "cloudfault:baseline",
    status: "queued",
    totalTests: plan.scenarios.length,
    passedTests: 0,
    failedTests: 0,
    skippedTests: plan.scenarios.length,
    coverageSummary: `${plan.strategy} plan: ${plan.scenarios.length} scenarios over ${plan.metadata.faultPoints} fault points (${plan.metadata.perturbations} perturbations); ${reason}`,
    durationMs: options.durationMs,
  };
}

export interface RunEvidenceOptions {
  suiteName?: string;
  /** Planned scenarios that a budget or early stop kept from running. */
  skipped?: number;
}

/** Evidence for an executed search: one test per scenario, the baseline included. */
export function runEvidence(testName: string, baseline: RunResult | undefined, runs: readonly RunResult[], options: RunEvidenceOptions = {}): EvidenceDraft {
  const all = baseline ? [baseline, ...runs] : [...runs];
  const failed = all.filter((run) => run.checks.some((check) => !check.valid));
  const checkers = [...new Set(failed.flatMap((run) => run.checks.filter((check) => !check.valid).map((check) => check.checker)))].sort();
  const skipped = options.skipped ?? 0;
  const durations = all.map((run) => run.durationMs).filter((value): value is number => typeof value === "number");
  return {
    suiteName: options.suiteName ?? `cloudfault:${testName}`,
    status: failed.length ? "failed" : "passed",
    totalTests: all.length + skipped,
    passedTests: all.length - failed.length,
    failedTests: failed.length,
    skippedTests: skipped,
    coverageSummary: failed.length
      ? `${failed.length}/${all.length} scenarios violated invariants (${checkers.join(", ")})`
      : `${all.length} scenarios held every invariant${skipped ? `; ${skipped} not executed` : ""}`,
    durationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : undefined,
  };
}

/**
 * A run ID that is stable per suite, app and commit. ForgeGraph upserts on
 * (source, externalRunId), so re-running the same suite against the same
 * commit updates the existing test run instead of adding another.
 */
export function evidenceRunId(suiteName: string, app: string, sha: string): string {
  return `${suiteName}:${app}:${sha.slice(0, 12)}`;
}

export interface BindOptions {
  changesetId: string;
  externalRunId: string;
  source?: ForgeGraphEvidenceSource;
}

export function toTestRunEvidence(draft: EvidenceDraft, options: BindOptions): ForgeGraphTestRunEvidence {
  const evidence: ForgeGraphTestRunEvidence = {
    type: "test_run",
    changesetId: options.changesetId,
    source: options.source ?? "gitea_ci",
    externalRunId: options.externalRunId,
    ...draft,
  };
  if (evidence.coveragePercent === undefined) delete evidence.coveragePercent;
  if (evidence.durationMs === undefined) delete evidence.durationMs;
  return evidence;
}
