import path from "node:path";
import { STARTER_PLAN, configCrons, inspectRepository, starterFaultPoints } from "./project.mjs";
import { applyOverrides, displayPath, executionOptions, finishSuite, plainResult } from "./run.mjs";

const core = () => import("@cloudfault/core");
const cloudflare = () => import("@cloudfault/cloudflare");
const smokeModule = () => import("@cloudfault/cloudflare/smoke");

function notRunnable(name, wrangler, reason, cwd) {
  return { kind: "search", name, module: wrangler, status: "not-runnable", reason, wrangler: displayPath(wrangler, cwd) };
}

/**
 * The config-free search `cloudfault ci --starter` runs for every Wrangler
 * config under `roots`: the plan `cloudfault init` would generate, executed
 * in-process through the smoke execute(). Scenarios whose faults cannot be
 * applied from outside the Worker are left out (and counted); a Worker that
 * cannot start is `not-runnable`, which is reported but does not fail CI.
 */
export async function runStarterSuites(roots, overrides = {}, { cwd = process.cwd(), onResult } = {}) {
  const { planScenarios } = await core();
  const cf = await cloudflare();
  const { createSmokeExecute, SmokeHarnessError } = await smokeModule();
  const { executeScenarioPlan } = await core();
  const records = [];
  const seen = new Set();
  for (const root of roots.length ? roots : ["."]) {
    for (const worker of inspectRepository(path.resolve(cwd, root))) {
      if (seen.has(worker.wrangler)) continue;
      seen.add(worker.wrangler);
      const started = performance.now();
      const name = `starter:${worker.topology?.name ?? displayPath(worker.wrangler, cwd)}`;
      let record;
      if (!worker.topology) {
        record = notRunnable(name, worker.wrangler, "unreadable Wrangler config", cwd);
      } else {
        const bindings = worker.topology.bindings ?? [];
        const config = applyOverrides({ name, ...STARTER_PLAN }, overrides);
        const smoke = createSmokeExecute({ config: worker.wrangler, name: worker.topology.name, bindings, crons: configCrons(worker.topology) });
        const plan = planScenarios(starterFaultPoints(bindings, cf), { strategy: config.strategy, maxDepth: config.maxDepth, maxScenarios: config.maxScenarios, seed: config.seed });
        const runnable = plan.scenarios.filter((scenario) => scenario.perturbations.every(smoke.supports));
        const runnablePlan = { ...plan, scenarios: runnable };
        try {
          const raw = await executeScenarioPlan(runnablePlan, smoke, executionOptions(config));
          record = await finishSuite({
            config,
            name,
            plan: runnablePlan,
            result: plainResult(raw, runnablePlan),
            started,
            extra: { starter: true, wrangler: displayPath(worker.wrangler, cwd), unsupported: plan.scenarios.length - runnable.length },
          });
        } catch (error) {
          record = error instanceof SmokeHarnessError
            ? notRunnable(name, worker.wrangler, error.message.split("\n")[0], cwd)
            : { kind: "search", name, module: worker.wrangler, status: "error", error };
        }
      }
      record.durationMs ??= performance.now() - started;
      records.push(record);
      onResult?.(record);
    }
  }
  return records;
}
