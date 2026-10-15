import { painter, type ColorStyle, type Painter } from "./color.js";
import type { ActualOutcome, CheckResult, FailureArtifact, HistoryEvent, HistoryEventType, ObservedOutcome, Perturbation } from "./types.js";

export interface RenderOptions {
  /** Emit ANSI color. Off by default so saved artifacts and file reports stay plain. */
  color?: boolean;
}

const eventStyles: Record<HistoryEventType, ColorStyle | readonly ColorStyle[]> = {
  invoke: "blue",
  ok: "green",
  fail: ["bold", "red"],
  info: "yellow",
  fault: ["bold", "magenta"],
  semantic: "magenta",
  checkpoint: "cyan",
};

const outcomeStyles: Record<ActualOutcome | ObservedOutcome, ColorStyle> = {
  committed: "green",
  success: "green",
  "not-committed": "red",
  "definite-failure": "red",
  unknown: "yellow",
  indeterminate: "yellow",
};

function pad(value: unknown, length: number): string {
  return String(value ?? "").padEnd(length);
}

function operationLabel(event: HistoryEvent, paint: Painter): string {
  const op = event.operation;
  if (!op) return "";
  const resource = op.resource ? `(${op.resource})` : "";
  return `${paint("dim", `${op.target ?? op.adapter ?? "app"}.`)}${paint("bold", op.name)}${resource}`;
}

function outcomeLabel(event: HistoryEvent, paint: Painter): string {
  if (!event.outcome) return "";
  const chunks = [];
  for (const key of ["actual", "observed"] as const) {
    const value = event.outcome[key];
    if (value) chunks.push(`${paint("dim", `${key}=`)}${paint(outcomeStyles[value], value)}`);
  }
  return chunks.join(" ");
}

function perturbationLabel(event: HistoryEvent, paint: Painter): string {
  if (event.type !== "fault" && event.type !== "semantic") return "";
  const value = event.value as Partial<Perturbation> | undefined;
  return value?.id ? `${paint("magenta", `[${value.id}]`)} ${value.description ?? value.kind ?? ""}` : "";
}

export interface TimelineOptions extends RenderOptions {
  includeAbsoluteTime?: boolean;
}

export function renderTimeline(events: readonly HistoryEvent[], options: TimelineOptions = {}): string {
  if (events.length === 0) return "(empty history)";
  const paint = painter(options.color === true);
  const start = events[0]?.at ?? 0;
  const rows = events.map((event) => {
    const time = options.includeAbsoluteTime ? event.at.toFixed(3) : `+${(event.at - start).toFixed(3)}ms`;
    const detail = [operationLabel(event, paint), outcomeLabel(event, paint), perturbationLabel(event, paint)].filter(Boolean).join(" ");
    const process = event.process === "nemesis" ? paint("magenta", pad(event.process, 12)) : pad(event.process, 12);
    return `${paint("gray", String(event.seq).padStart(4, "0"))} ${paint("gray", pad(time, 14))} ${paint(eventStyles[event.type] ?? "cyan", pad(event.type, 10))} ${process} ${detail}`.trimEnd();
  });
  return rows.join("\n");
}

export function renderChecks(checks: readonly CheckResult[], options: RenderOptions = {}): string {
  if (checks.length === 0) return "No checkers ran.";
  const paint = painter(options.color === true);
  return checks
    .map((check) => {
      const status = check.valid ? paint(["bold", "green"], "PASS") : paint(["bold", "red"], "FAIL");
      const message = check.message ? ` — ${check.valid ? check.message : paint("red", check.message)}` : "";
      return `${status} ${check.checker}${message}`;
    })
    .join("\n");
}

export function renderPerturbationSet(perturbations: readonly Perturbation[], options: RenderOptions = {}): string {
  if (perturbations.length === 0) return "  (none)";
  const paint = painter(options.color === true);
  return perturbations.map((item) => `  - ${paint("magenta", item.id)}: ${item.description}`).join("\n");
}

export function renderFailureArtifact(artifact: FailureArtifact, options: RenderOptions = {}): string {
  const paint = painter(options.color === true);
  const heading = (text: string) => paint(["bold", "cyan"], text);
  const lines = [
    `${paint(["bold", "red"], "CloudFault failure")} — ${paint("bold", artifact.testName)}`,
    `${paint("dim", "Scenario:")} ${artifact.scenario.id}`,
    artifact.seed === undefined ? undefined : `${paint("dim", "Seed:")} ${artifact.seed}`,
    "",
    heading("Checks:"),
    renderChecks(artifact.checks, options),
    "",
    heading("Minimal Failure Set:"),
    renderPerturbationSet(artifact.minimalFailureSet ?? artifact.scenario.perturbations, options),
    "",
    heading("Timeline:"),
    renderTimeline(artifact.history, options),
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}
