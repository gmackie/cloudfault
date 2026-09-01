import type { CheckResult, FailureArtifact, RunResult } from "./types.js";
import { dependencyCoverage, type DependencyCoverage } from "./discovery.js";
import { buildFailureWitness } from "./diagnostics.js";
import { renderTimeline } from "./report.js";

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface RunSummary {
  scenario: string;
  valid: boolean;
  failedCheckers: readonly string[];
  perturbations: readonly string[];
  historyEvents: number;
  durationMs?: number;
}

export function summarizeRun(run: RunResult): RunSummary {
  return {
    scenario: run.scenario.id,
    valid: run.checks.every((check) => check.valid),
    failedCheckers: run.checks.filter((check) => !check.valid).map((check) => check.checker),
    perturbations: run.scenario.perturbations.map((item) => item.id),
    historyEvents: run.history.length,
    durationMs: run.durationMs,
  };
}

export function jsonReport(baseline: RunResult, runs: readonly RunResult[]): string {
  return `${JSON.stringify({
    schema: "cloudfault.report",
    version: 1,
    baseline: summarizeRun(baseline),
    runs: runs.map(summarizeRun),
    dependencyCoverage: dependencyCoverage(baseline, runs),
  }, null, 2)}\n`;
}

export function junitReport(testName: string, baseline: RunResult, runs: readonly RunResult[]): string {
  const all = [baseline, ...runs];
  const failures = all.filter((run) => run.checks.some((check) => !check.valid)).length;
  const duration = all.reduce((sum, run) => sum + (run.durationMs ?? 0), 0) / 1000;
  const cases = all.map((run) => {
    const failed = run.checks.filter((check) => !check.valid);
    const attrs = `name="${escapeXml(run.scenario.id)}" classname="${escapeXml(testName)}" time="${((run.durationMs ?? 0) / 1000).toFixed(6)}"`;
    if (!failed.length) return `    <testcase ${attrs}/>`;
    const body = failed.map((check) => `      <failure type="${escapeXml(check.checker)}" message="${escapeXml(check.message ?? "CloudFault invariant failed")}">${escapeXml(JSON.stringify(check.details ?? null))}</failure>`).join("\n");
    return `    <testcase ${attrs}>\n${body}\n    </testcase>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(testName)}" tests="${all.length}" failures="${failures}" time="${duration.toFixed(6)}">\n${cases}\n</testsuite>\n`;
}

function annotationProperties(check: CheckResult): string {
  const details = check.details as Record<string, unknown> | undefined;
  const file = typeof details?.file === "string" ? `file=${encodeURIComponent(details.file)}` : undefined;
  const line = typeof details?.line === "number" ? `line=${details.line}` : undefined;
  const col = typeof details?.column === "number" ? `col=${details.column}` : undefined;
  const title = `title=${encodeURIComponent(`CloudFault: ${check.checker}`)}`;
  return [file, line, col, title].filter(Boolean).join(",");
}

export function githubAnnotations(run: RunResult): readonly string[] {
  return run.checks.filter((check) => !check.valid).map((check) => {
    const properties = annotationProperties(check);
    const message = encodeURIComponent(check.message ?? `${check.checker} failed`);
    return `::error ${properties}::${message}`;
  });
}

export interface HtmlReportOptions {
  title?: string;
  dependencyCoverage?: DependencyCoverage;
}

export function htmlFailureReport(artifact: FailureArtifact, options: HtmlReportOptions = {}): string {
  const title = options.title ?? `CloudFault — ${artifact.testName}`;
  const failed = artifact.checks.filter((check) => !check.valid);
  const mfs = artifact.minimalFailureSet ?? artifact.scenario.perturbations;
  const coverage = options.dependencyCoverage;
  const witness = buildFailureWitness(artifact);
  const rows = artifact.history.map((event) => {
    const op = event.operation;
    return `<tr><td>${event.seq}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.process)}</td><td>${escapeHtml(op ? `${op.target ?? op.adapter ?? "app"}.${op.name}` : "")}</td><td>${escapeHtml(op?.resource ?? "")}</td><td>${escapeHtml(event.outcome ? `${event.outcome.actual ?? ""} / ${event.outcome.observed ?? ""}` : "")}</td></tr>`;
  }).join("\n");
  const checks = artifact.checks.map((check) => `<li class="${check.valid ? "pass" : "fail"}"><strong>${check.valid ? "PASS" : "FAIL"}</strong> ${escapeHtml(check.checker)}${check.message ? ` — ${escapeHtml(check.message)}` : ""}</li>`).join("\n");
  const faults = mfs.map((item) => `<li><code>${escapeHtml(item.id)}</code> — ${escapeHtml(item.description)}</li>`).join("\n");
  const coverageHtml = coverage ? `<section><h2>Dependency coverage</h2><p>${coverage.exercised}/${coverage.discovered} discovered calls exercised (${(coverage.ratio * 100).toFixed(1)}%).</p>${coverage.unexercised.length ? `<ul>${coverage.unexercised.map((call) => `<li>${escapeHtml(call.target)}.${escapeHtml(call.operation)}</li>`).join("")}</ul>` : ""}</section>` : "";
  const textTimeline = escapeHtml(renderTimeline(artifact.history));
  const causal = witness.causalEdges.length
    ? `<ol>${witness.causalEdges.map((edge) => `<li><code>#${edge.from}</code> → <code>#${edge.to}</code> <strong>${escapeHtml(edge.kind)}</strong>${edge.reason ? ` — ${escapeHtml(edge.reason)}` : ""}</li>`).join("")}</ol>`
    : "<p>No causal edges were inferred.</p>";
  const indeterminate = witness.indeterminateOperations.map((event) => `<li><code>#${event.seq}</code> ${escapeHtml(event.operation?.target ?? event.operation?.adapter ?? "app")}.${escapeHtml(event.operation?.name ?? "operation")} — actual ${escapeHtml(event.outcome?.actual ?? "unknown")}, caller observed ${escapeHtml(event.outcome?.observed ?? "indeterminate")}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#1f2937}code,pre{font-family:ui-monospace,SFMono-Regular,monospace}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid #d1d5db;padding:.45rem;text-align:left;vertical-align:top}th{background:#f3f4f6}.fail{color:#b91c1c}.pass{color:#047857}.badge{display:inline-block;padding:.2rem .5rem;border-radius:.35rem;background:#fef2f2;color:#991b1b}pre{overflow:auto;background:#111827;color:#f9fafb;padding:1rem;border-radius:.5rem}section{margin:2rem 0}</style></head>
<body><h1>${escapeHtml(title)}</h1><p><span class="badge">INVALID</span> Scenario <code>${escapeHtml(artifact.scenario.id)}</code></p>
<section><h2>Failure witness</h2><p>${escapeHtml(witness.summary)}</p>${indeterminate ? `<h3>Indeterminate operations</h3><ul>${indeterminate}</ul>` : ""}</section>
<section><h2>Checks</h2><ul>${checks}</ul></section>
<section><h2>Minimal Failure Set</h2><ul>${faults}</ul></section>
<section><h2>Causal chain</h2>${causal}</section>
${coverageHtml}
<section><h2>History</h2><table><thead><tr><th>#</th><th>type</th><th>process</th><th>operation</th><th>resource</th><th>outcome</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h2>Text timeline</h2><pre>${textTimeline}</pre></section>
<section><h2>Raw checker failures</h2><pre>${escapeHtml(JSON.stringify(failed, null, 2))}</pre></section>
</body></html>\n`;
}
