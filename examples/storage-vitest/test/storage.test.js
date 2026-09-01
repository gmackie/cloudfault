import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ScenarioController } from "@cloudfault/core";
import {
  createD1FaultProxy,
  createR2FaultProxy,
  d1CommitThenTimeout,
  r2CommitThenTimeout,
} from "@cloudfault/cloudflare";

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS writes; CREATE TABLE writes (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
  const listed = await env.BUCKET.list();
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((object) => object.key));
});

describe("CloudFault against native D1 and R2 bindings", () => {
  it("models a D1 write that committed before the result became indeterminate", async () => {
    const controller = new ScenarioController({
      id: "d1-ambiguous",
      perturbations: [d1CommitThenTimeout("DB")],
    });
    const db = createD1FaultProxy(env.DB, { controller, target: "DB", process: "storage-test" });

    await expect(
      db.prepare("INSERT INTO writes (id, value) VALUES (?, ?)").bind(1, "committed").run(),
    ).rejects.toThrow(/may have committed/i);

    const row = await env.DB.prepare("SELECT id, value FROM writes WHERE id = 1").first();
    expect(row).toEqual({ id: 1, value: "committed" });
    expect(controller.history.snapshot().some((event) =>
      event.type === "info" && event.operation?.name === "d1.run" && event.outcome?.actual === "committed"
    )).toBe(true);
  });

  it("models an R2 put that committed before the caller lost the result", async () => {
    const controller = new ScenarioController({
      id: "r2-ambiguous",
      perturbations: [r2CommitThenTimeout("BUCKET")],
    });
    const bucket = createR2FaultProxy(env.BUCKET, { controller, target: "BUCKET", process: "storage-test" });

    await expect(bucket.put("artifact.txt", "committed")).rejects.toThrow(/may have committed/i);

    const object = await env.BUCKET.get("artifact.txt");
    expect(object).not.toBeNull();
    expect(await object.text()).toBe("committed");
    expect(controller.history.snapshot().some((event) =>
      event.type === "info" && event.operation?.name === "r2.put" && event.outcome?.actual === "committed"
    )).toBe(true);
  });
});
