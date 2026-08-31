import type { FailureArtifact, Perturbation, ReplayDescriptor, RunResult } from "./types.js";

export interface CreateFailureArtifactOptions<State = unknown> {
  testName: string;
  run: RunResult<State>;
  minimalFailureSet?: readonly Perturbation[];
  replay?: ReplayDescriptor;
  environment?: FailureArtifact["environment"];
  metadata?: Record<string, unknown>;
  createdAt?: Date | string;
}

export function createFailureArtifact<State = unknown>(
  options: CreateFailureArtifactOptions<State>,
): FailureArtifact<State> {
  const createdAt = options.createdAt instanceof Date
    ? options.createdAt.toISOString()
    : options.createdAt ?? new Date().toISOString();

  return {
    schema: "cloudfault.failure",
    schemaVersion: 1,
    createdAt,
    testName: options.testName,
    seed: options.run.scenario.seed,
    scenario: options.run.scenario,
    minimalFailureSet: options.minimalFailureSet,
    history: options.run.history,
    checks: options.run.checks,
    state: options.run.state,
    replay: options.replay,
    environment: options.environment,
    metadata: options.metadata,
  };
}

export function serializeFailureArtifact(artifact: FailureArtifact, space = 2): string {
  return JSON.stringify(artifact, null, space);
}

export function parseFailureArtifact(input: string | unknown): FailureArtifact {
  const value = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (!value || typeof value !== "object") throw new Error("Invalid CloudFault failure artifact");
  const candidate = value as Partial<FailureArtifact>;
  if (candidate.schema !== "cloudfault.failure" || candidate.schemaVersion !== 1) {
    throw new Error(`Unsupported CloudFault failure artifact schema: ${String(candidate.schema)}@${String(candidate.schemaVersion)}`);
  }
  if (!candidate.testName || !candidate.scenario || !Array.isArray(candidate.history) || !Array.isArray(candidate.checks)) {
    throw new Error("CloudFault failure artifact is missing required fields");
  }
  return candidate as FailureArtifact;
}
