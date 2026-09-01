import type { CheckResult, FailureArtifact, HistoryEvent, Perturbation, RunResult } from "./types.js";

export type CausalEdgeKind = "process-order" | "parent" | "completion" | "resource-order" | "retry" | "perturbation";

export interface CausalEdge {
  from: number;
  to: number;
  kind: CausalEdgeKind;
  reason?: string;
}

export interface CausalGraph {
  events: readonly HistoryEvent[];
  edges: readonly CausalEdge[];
}

function keyOf(event: HistoryEvent): string | undefined {
  const op = event.operation;
  if (!op) return undefined;
  return `${op.target ?? op.adapter ?? "app"}|${op.name}|${op.resource ?? ""}`;
}

export function buildCausalGraph(history: readonly HistoryEvent[]): CausalGraph {
  const edges: CausalEdge[] = [];
  const invokeByOperation = new Map<string, HistoryEvent>();
  const completionByOperation = new Map<string, HistoryEvent>();
  const lastByProcess = new Map<string, HistoryEvent>();
  const lastInvokeByResource = new Map<string, HistoryEvent>();
  const priorInvokeByLogicalCall = new Map<string, HistoryEvent>();

  for (const event of history) {
    const process = String(event.process);
    const priorProcess = lastByProcess.get(process);
    if (priorProcess && priorProcess.seq !== event.seq) edges.push({ from: priorProcess.seq, to: event.seq, kind: "process-order" });
    lastByProcess.set(process, event);

    if (event.operation && event.type === "invoke") {
      invokeByOperation.set(event.operation.id, event);
      const resourceKey = keyOf(event);
      if (resourceKey) {
        const previous = lastInvokeByResource.get(resourceKey);
        if (previous && previous.operation?.id !== event.operation.id) edges.push({ from: previous.seq, to: event.seq, kind: "resource-order", reason: resourceKey });
        lastInvokeByResource.set(resourceKey, event);

        const priorLogical = priorInvokeByLogicalCall.get(resourceKey);
        const attempt = event.operation.attempt ?? event.operation.occurrence ?? 1;
        const previousAttempt = priorLogical?.operation?.attempt ?? priorLogical?.operation?.occurrence ?? 1;
        if (priorLogical && attempt > previousAttempt) edges.push({ from: priorLogical.seq, to: event.seq, kind: "retry", reason: `${previousAttempt}->${attempt}` });
        priorInvokeByLogicalCall.set(resourceKey, event);
      }
    }

    if (event.operation && ["ok", "fail", "info"].includes(event.type)) completionByOperation.set(event.operation.id, event);
  }

  for (const event of history) {
    const op = event.operation;
    if (!op) continue;
    if (event.type === "invoke" && op.parentId) {
      const parent = invokeByOperation.get(op.parentId);
      if (parent) edges.push({ from: parent.seq, to: event.seq, kind: "parent" });
    }
    if (["ok", "fail", "info"].includes(event.type)) {
      const invoke = invokeByOperation.get(op.id);
      if (invoke && invoke.seq !== event.seq) edges.push({ from: invoke.seq, to: event.seq, kind: "completion" });
    }
    if (event.type === "fault" || event.type === "semantic") {
      const completion = completionByOperation.get(op.id);
      if (completion && completion.seq > event.seq) edges.push({ from: event.seq, to: completion.seq, kind: "perturbation" });
    }
  }

  const deduped = new Map<string, CausalEdge>();
  for (const edge of edges) deduped.set(`${edge.from}|${edge.to}|${edge.kind}`, edge);
  return { events: [...history], edges: [...deduped.values()].sort((a, b) => a.to - b.to || a.from - b.from) };
}

export interface FailureWitness {
  failedChecks: readonly CheckResult[];
  minimalFailureSet: readonly Perturbation[];
  indeterminateOperations: readonly HistoryEvent[];
  failedOperations: readonly HistoryEvent[];
  perturbationEvents: readonly HistoryEvent[];
  relevantEvents: readonly HistoryEvent[];
  causalEdges: readonly CausalEdge[];
  summary: string;
}

function historyAndChecks(source: FailureArtifact | RunResult): { history: readonly HistoryEvent[]; checks: readonly CheckResult[]; perturbations: readonly Perturbation[] } {
  if ("schema" in source) return { history: source.history, checks: source.checks, perturbations: source.minimalFailureSet ?? source.scenario.perturbations };
  return { history: source.history, checks: source.checks, perturbations: source.scenario.perturbations };
}

export function buildFailureWitness(source: FailureArtifact | RunResult, minimalFailureSet?: readonly Perturbation[]): FailureWitness {
  const { history, checks, perturbations } = historyAndChecks(source);
  const mfs = minimalFailureSet ?? perturbations;
  const failedChecks = checks.filter((check) => !check.valid);
  const indeterminateOperations = history.filter((event) => event.type === "info");
  const failedOperations = history.filter((event) => event.type === "fail");
  const perturbationEvents = history.filter((event) => event.type === "fault" || event.type === "semantic");
  const graph = buildCausalGraph(history);

  const selected = new Set<number>();
  for (const event of [...indeterminateOperations, ...failedOperations, ...perturbationEvents]) selected.add(event.seq);
  for (const check of failedChecks) {
    const details = check.details as Record<string, unknown> | undefined;
    if (typeof details?.eventSeq === "number") selected.add(details.eventSeq);
    if (Array.isArray(details?.eventSeqs)) for (const value of details.eventSeqs) if (typeof value === "number") selected.add(value);
  }
  if (!selected.size && history.length) selected.add(history.at(-1)!.seq);

  const incoming = new Map<number, CausalEdge[]>();
  for (const edge of graph.edges) {
    const bucket = incoming.get(edge.to) ?? [];
    bucket.push(edge);
    incoming.set(edge.to, bucket);
  }
  const queue = [...selected];
  while (queue.length && selected.size < 200) {
    const current = queue.shift()!;
    for (const edge of incoming.get(current) ?? []) {
      if (selected.has(edge.from)) continue;
      selected.add(edge.from);
      queue.push(edge.from);
    }
  }

  const relevantEvents = history.filter((event) => selected.has(event.seq));
  const relevantSeq = new Set(relevantEvents.map((event) => event.seq));
  const causalEdges = graph.edges.filter((edge) => relevantSeq.has(edge.from) && relevantSeq.has(edge.to));
  const summary = `${failedChecks.length} failed checker${failedChecks.length === 1 ? "" : "s"}; ${mfs.length} perturbation${mfs.length === 1 ? "" : "s"} in MFS; ${indeterminateOperations.length} indeterminate operation${indeterminateOperations.length === 1 ? "" : "s"}`;
  return { failedChecks, minimalFailureSet: mfs, indeterminateOperations, failedOperations, perturbationEvents, relevantEvents, causalEdges, summary };
}

export interface UnifiedIncidentModel {
  schema: "cloudfault.incident";
  version: 1;
  scenario: string;
  valid: boolean;
  witness: FailureWitness;
  history: readonly HistoryEvent[];
  checks: readonly CheckResult[];
}

export function buildIncidentModel(source: FailureArtifact | RunResult, minimalFailureSet?: readonly Perturbation[]): UnifiedIncidentModel {
  const data = historyAndChecks(source);
  return {
    schema: "cloudfault.incident",
    version: 1,
    scenario: "schema" in source ? source.scenario.id : source.scenario.id,
    valid: data.checks.every((check) => check.valid),
    witness: buildFailureWitness(source, minimalFailureSet),
    history: data.history,
    checks: data.checks,
  };
}
