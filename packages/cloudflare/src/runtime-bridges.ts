import type { Perturbation, Scenario } from "@cloudfault/core";

function active(
  scenario: Pick<Scenario, "perturbations">,
  target: string,
): readonly Perturbation[] {
  return scenario.perturbations.filter((item) => item.target === target || item.selector?.target === target);
}

export interface WorkflowStepSelector {
  name: string;
  index?: number;
}

export interface WorkflowInstanceModifierLike {
  disableSleeps(steps?: readonly WorkflowStepSelector[]): Promise<void> | void;
  disableRetryDelays(steps?: readonly WorkflowStepSelector[]): Promise<void> | void;
  mockStepResult(step: WorkflowStepSelector, result: unknown): Promise<void> | void;
  mockStepError(step: WorkflowStepSelector, error: Error, times?: number): Promise<void> | void;
  forceStepTimeout(step: WorkflowStepSelector, times?: number): Promise<void> | void;
  mockEvent(event: { type: string; payload: unknown }): Promise<void> | void;
  forceEventTimeout(step: WorkflowStepSelector): Promise<void> | void;
}

export interface WorkflowIntrospectorLike {
  modifyAll(fn: (modifier: WorkflowInstanceModifierLike) => Promise<void>): Promise<void>;
  get(): Promise<readonly unknown[]> | readonly unknown[];
  dispose?(): Promise<void>;
}

export interface WorkflowScenarioBridgeOptions {
  target: string;
  defaultStep?: string;
  disableSleeps?: boolean;
  disableRetryDelays?: boolean;
}

/** Translate CloudFault Workflow perturbations into first-class Workflow test modifiers. */
export async function applyWorkflowScenario(
  introspector: WorkflowIntrospectorLike,
  scenario: Pick<Scenario, "perturbations">,
  options: WorkflowScenarioBridgeOptions,
): Promise<void> {
  const perturbations = active(scenario, options.target);
  await introspector.modifyAll(async (modifier) => {
    if (options.disableSleeps) await modifier.disableSleeps();
    if (options.disableRetryDelays) await modifier.disableRetryDelays();

    for (const item of perturbations) {
      const stepName = item.selector?.operation ?? item.operation ?? options.defaultStep;
      if (item.kind === "workflow-step-retry") {
        if (!stepName) throw new Error(`${item.id} requires a workflow step name`);
        await modifier.disableRetryDelays([{ name: stepName }]);
        await modifier.mockStepError(
          { name: stepName },
          new Error(String(item.metadata?.message ?? "CloudFault injected Workflow retry")),
          typeof item.metadata?.times === "number" ? item.metadata.times : 1,
        );
      } else if (item.kind === "workflow-step-timeout") {
        if (!stepName) throw new Error(`${item.id} requires a workflow step name`);
        await modifier.disableRetryDelays([{ name: stepName }]);
        await modifier.forceStepTimeout(
          { name: stepName },
          typeof item.metadata?.times === "number" ? item.metadata.times : 1,
        );
      } else if (item.kind === "workflow-event-timeout") {
        if (!stepName) throw new Error(`${item.id} requires an event step name`);
        await modifier.forceEventTimeout({ name: stepName });
      } else if (item.kind === "workflow-mock-step-result") {
        if (!stepName) throw new Error(`${item.id} requires a workflow step name`);
        await modifier.mockStepResult({ name: stepName }, item.metadata?.result);
      } else if (item.kind === "workflow-mock-event") {
        const type = String(item.metadata?.type ?? stepName ?? "event");
        await modifier.mockEvent({ type, payload: item.metadata?.payload });
      } else if (item.kind === "workflow-disable-sleep") {
        await modifier.disableSleeps(stepName ? [{ name: stepName }] : undefined);
      }
    }
  });
}

export function workflowStepTimeout(target: string, step: string, times = 1): Perturbation {
  return {
    id: `${target}:step-timeout:${step}:${times}`,
    target,
    operation: step,
    kind: "workflow-step-timeout",
    description: `${target} step ${step} times out ${times} time(s) before retry/error handling`,
    selector: { target, operation: step },
    metadata: { times },
  };
}

export function workflowEventTimeout(target: string, step: string): Perturbation {
  return {
    id: `${target}:event-timeout:${step}`,
    target,
    operation: step,
    kind: "workflow-event-timeout",
    description: `${target} waitForEvent step ${step} times out`,
    selector: { target, operation: step },
  };
}

export interface CloudflareTestApiLike {
  runDurableObjectAlarm(stub: unknown): Promise<boolean>;
  evictDurableObject?(stub: unknown, options?: { webSockets?: "hibernate" | "close" }): Promise<void>;
}

async function optionalCloudflareTest(): Promise<CloudflareTestApiLike> {
  try {
    return await Function("return import('cloudflare:test')")() as CloudflareTestApiLike;
  } catch (error) {
    throw new Error("Durable Object runtime helpers require the Workers Vitest cloudflare:test runtime", { cause: error });
  }
}

export interface DurableObjectAlarmScenarioOptions {
  target: string;
  api?: CloudflareTestApiLike;
  maxExecutions?: number;
}

/** Execute a real Durable Object alarm through cloudflare:test. */
export async function runDurableObjectAlarmScenario(
  stub: unknown,
  scenario: Pick<Scenario, "perturbations">,
  options: DurableObjectAlarmScenarioOptions,
): Promise<readonly boolean[]> {
  const api = options.api ?? await optionalCloudflareTest();
  const perturbations = active(scenario, options.target);
  const duplicate = perturbations.some((item) => item.kind === "alarm-retry");
  const requested = duplicate ? 2 : 1;
  const executions = Math.min(requested, options.maxExecutions ?? 2);
  const results: boolean[] = [];
  for (let index = 0; index < executions; index++) {
    const ran = await api.runDurableObjectAlarm(stub);
    results.push(ran);
    if (!ran) break;
  }
  return results;
}

export interface DurableObjectResetScenarioOptions {
  target: string;
  api?: CloudflareTestApiLike;
  webSockets?: "hibernate" | "close";
}

/**
 * Evict a real Durable Object instance when the scenario contains the
 * `durable-object-reset` degradation. Durable storage remains intact while
 * in-memory state is reconstructed on the next call, matching the failure
 * boundary CloudFault wants to exercise.
 */
export async function applyDurableObjectResetScenario(
  stub: unknown,
  scenario: Pick<Scenario, "perturbations">,
  options: DurableObjectResetScenarioOptions,
): Promise<boolean> {
  const reset = active(scenario, options.target).some((item) => item.kind === "durable-object-reset");
  if (!reset) return false;
  const api = options.api ?? await optionalCloudflareTest();
  if (!api.evictDurableObject) throw new Error("Installed cloudflare:test runtime does not expose evictDurableObject()");
  await api.evictDurableObject(stub, { webSockets: options.webSockets ?? "hibernate" });
  return true;
}
