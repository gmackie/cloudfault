import type { CheckResult, FailureArtifact, HistoryEvent, Perturbation } from "./types.js";

function pad(value: unknown, length: number): string {
  return String(value ?? "").padEnd(length);
}

function operationLabel(event: HistoryEvent): string {
  const op = event.operation;
  if (!op) return "";
  const resource = op.resource ? `(${op.resource})` : "";
  return `${op.target ?? op.adapter ?? "app"}.${op.name}${resource}`;
}

function outcomeLabel(event: HistoryEvent): string {
  if (!event.outcome) return "";
  const chunks = [];
  if (event.outcome.actual) chunks.push(`actual=${event.outcome.actual}`);
  if (event.outcome.observed) chunks.push(`observed=${event.outcome.observed}`);
  return chunks.join(" ");
}

function perturbationLabel(event: HistoryEvent): string {
  if (event.type !== "fault" && event.type !== "semantic") return "";
  const value = event.value as Partial<Perturbation> | undefined;
  return value?.id ? `[${value.id}] ${value.description ?? value.kind ?? ""}` : "";
}

export interface TimelineOptions {
  includeAbsoluteTime?: boolean;
}

export function renderTimeline(events: readonly HistoryEvent[], options: TimelineOptions = {}): string {
  if (events.length === 0) return "(empty history)";
  const start = events[0]?.at ?? 0;
  const rows = events.map((event) => {
    const time = options.includeAbsoluteTime ? event.at.toFixed(3) : `+${(event.at - start).toFixed(3)}ms`;
    const detail = [operationLabel(event), outcomeLabel(event), perturbationLabel(event)].filter(Boolean).join(" ");
    return `${String(event.seq).padStart(4, "0")} ${pad(time, 14)} ${pad(event.type, 10)} ${pad(event.process, 12)} ${detail}`.trimEnd();
  });
  return rows.join("\n");
}

export function renderChecks(checks: readonly CheckResult[]): string {
  if (checks.length === 0) return "No checkers ran.";
  return checks
    .map((check) => `${check.valid ? "PASS" : "FAIL"} ${check.checker}${check.message ? ` — ${check.message}` : ""}`)
    .join("\n");
}

export function renderPerturbationSet(perturbations: readonly Perturbation[]): string {
  if (perturbations.length === 0) return "  (none)";
  return perturbations.map((item) => `  - ${item.id}: ${item.description}`).join("\n");
}

export function renderFailureArtifact(artifact: FailureArtifact): string {
  const lines = [
    `CloudFault failure — ${artifact.testName}`,
    `Scenario: ${artifact.scenario.id}`,
    artifact.seed === undefined ? undefined : `Seed: ${artifact.seed}`,
    "",
    "Checks:",
    renderChecks(artifact.checks),
    "",
    "Minimal Failure Set:",
    renderPerturbationSet(artifact.minimalFailureSet ?? artifact.scenario.perturbations),
    "",
    "Timeline:",
    renderTimeline(artifact.history),
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}
