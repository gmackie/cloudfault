import test from "node:test";
import assert from "node:assert/strict";
import {
  History,
  createFailureArtifact,
  githubAnnotations,
  htmlFailureReport,
  jsonReport,
  junitReport,
} from "@cloudfault/core";
import {
  applyWorkflowScenario,
  dispatchQueueUntilSettled,
  duplicateAlarmDelivery,
  runDurableObjectAlarmScenario,
  workflowStepRetry,
} from "@cloudfault/cloudflare";
import { findScenarioCounterexample, loadFastCheck } from "@cloudfault/fast-check";

test("Queue lifecycle retries poison messages and dispatches exhausted work to DLQ", async () => {
  const calls = [];
  const miniflare = {
    async getWorker() {
      return {
        async queue(queue, messages) {
          calls.push({ queue, messages });
          if (queue === "events") return { outcome: "ok", explicitRetries: messages.map((message) => message.id) };
          return { outcome: "ok", ackAll: true };
        },
      };
    },
    async dispose() {},
  };
  const result = await dispatchQueueUntilSettled(miniflare, {
    queue: "events",
    deadLetterQueue: "events-dlq",
    maxRetries: 2,
    messages: [{ id: "poison", body: { value: 1 } }],
  });
  assert.equal(result.attempts.length, 3);
  assert.equal(result.deadLettered.length, 1);
  assert.equal(result.deadLettered[0].attempts, 3);
  assert.equal(calls.at(-1).queue, "events-dlq");
});

test("Workflow scenario translates retry semantics to first-class introspector modifiers", async () => {
  const actions = [];
  const introspector = {
    async modifyAll(fn) {
      await fn({
        async disableSleeps(value) { actions.push(["disableSleeps", value]); },
        async disableRetryDelays(value) { actions.push(["disableRetryDelays", value]); },
        async mockStepResult(step, result) { actions.push(["mockStepResult", step, result]); },
        async mockStepError(step, error, times) { actions.push(["mockStepError", step, error.message, times]); },
        async forceStepTimeout(step, times) { actions.push(["forceStepTimeout", step, times]); },
        async mockEvent(event) { actions.push(["mockEvent", event]); },
        async forceEventTimeout(step) { actions.push(["forceEventTimeout", step]); },
      });
    },
    get() { return []; },
  };
  await applyWorkflowScenario(introspector, {
    perturbations: [workflowStepRetry("ORDER_FLOW", "charge")],
  }, { target: "ORDER_FLOW" });
  assert.deepEqual(actions[0], ["disableRetryDelays", [{ name: "charge" }]]);
  assert.equal(actions[1][0], "mockStepError");
  assert.equal(actions[1][3], 1);
});

test("Durable Object alarm bridge repeats an alarm under alarm-retry semantics", async () => {
  let runs = 0;
  const api = { async runDurableObjectAlarm() { runs++; return true; } };
  const result = await runDurableObjectAlarmScenario({}, {
    perturbations: [duplicateAlarmDelivery("ORDERS")],
  }, { target: "ORDERS", api });
  assert.deepEqual(result, [true, true]);
  assert.equal(runs, 2);
});

test("machine reporters describe the same failed history in JSON JUnit annotations and HTML", () => {
  const history = new History(() => 1);
  const operation = { id: "checkout", name: "checkout", process: 1 };
  history.invoke(operation);
  history.complete(operation, "ok");
  const baseline = { scenario: { id: "baseline", perturbations: [] }, history: history.snapshot(), checks: [{ checker: "ok", valid: true }] };
  const failed = {
    scenario: { id: "fault", perturbations: [{ id: "x", target: "stripe", operation: "charge", kind: "timeout", phase: "during-response", category: "provider", description: "timeout", actualOutcome: "committed", observedOutcome: "indeterminate" }] },
    history: history.snapshot(),
    checks: [{ checker: "one-charge", valid: false, message: "two charges" }],
  };
  const artifact = createFailureArtifact({ testName: "checkout", run: failed });
  assert.match(jsonReport(baseline, [failed]), /cloudfault.report/);
  assert.match(junitReport("checkout", baseline, [failed]), /<failure/);
  assert.match(githubAnnotations(failed)[0], /^::error/);
  assert.match(htmlFailureReport(artifact), /Minimal Failure Set/);
});

test("fast-check bridge returns a shrunk failing CloudFault scenario", async () => {
  const fc = await loadFastCheck();
  const failure = {
    id: "x",
    target: "X",
    operation: "op",
    kind: "failure",
    phase: "before-commit",
    category: "provider",
    description: "failure",
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
  };
  const counterexample = await findScenarioCounterexample(
    fc,
    [{ id: "X", target: "X", choices: [failure] }],
    async (scenario) => ({ scenario, history: [], checks: [{ checker: "property", valid: scenario.perturbations.length === 0 }] }),
    (run) => run.checks.every((check) => check.valid),
    { numRuns: 20, seed: 42 },
  );
  assert.ok(counterexample);
  assert.equal(counterexample.value.perturbations.length, 1);
});
