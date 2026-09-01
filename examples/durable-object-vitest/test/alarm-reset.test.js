import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyDurableObjectResetScenario,
  duplicateAlarmDelivery,
  durableObjectReset,
  runDurableObjectAlarmScenario,
} from "@cloudfault/cloudflare";

const cloudflareTestApi = {
  runDurableObjectAlarm,
  evictDurableObject,
};

describe("CloudFault Durable Object runtime semantics", () => {
  it("executes repeated alarm delivery against a real Durable Object", async () => {
    const stub = env.COUNTER.getByName("alarm-retry");
    await stub.scheduleAlarm();

    const results = await runDurableObjectAlarmScenario(stub, {
      perturbations: [duplicateAlarmDelivery("COUNTER")],
    }, { target: "COUNTER", api: cloudflareTestApi });

    expect(results).toEqual([true, true]);
    expect(await stub.getAlarmFires()).toBe(2);
  });

  it("evicts in-memory state while preserving durable storage", async () => {
    const stub = env.COUNTER.getByName("reset");
    await stub.incrementStored();
    await stub.incrementStored();
    await stub.recordHit();
    await stub.recordHit();
    expect(await stub.getStored()).toBe(2);
    expect(await stub.getHits()).toBe(2);

    const applied = await applyDurableObjectResetScenario(stub, {
      perturbations: [durableObjectReset("COUNTER")],
    }, { target: "COUNTER", api: cloudflareTestApi });

    expect(applied).toBe(true);
    expect(await stub.getStored()).toBe(2);
    expect(await stub.getHits()).toBe(0);
  });
});
