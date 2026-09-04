import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ScenarioController } from "@cloudfault/core";
import {
  createD1FaultProxy,
  createR2FaultProxy,
  d1BatchCommitThenResponseLost,
  d1CommitThenTimeout,
  d1PartialBatchApplication,
  D1ContractProbeRefusedError,
  D1IndeterminateError,
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

/**
 * The batch seam, against genuine workerd D1.
 *
 * `env.DB.batch()` here is the real implementation, so its atomicity is real:
 * the "no partial rows" assertions below are checked against the runtime, not
 * against a fixture that was told to behave.
 */
describe("CloudFault against D1Database.batch()", () => {
  const GUARD = "UPDATE workspaces SET bootstrapped = 1 WHERE id = 1 AND bootstrapped = 0";
  const MEMBER = "INSERT INTO members (workspace_id, actor) VALUES (1, ?)";

  // `members.workspace_id` is UNIQUE, so a second caller's INSERT raises a
  // constraint error. Real D1 batches are atomic, so that error also undoes the
  // guard UPDATE in the same batch -- which is precisely the guarantee this
  // service relies on without ever saying so.
  const completeBootstrap = async (db, actor) => {
    try {
      const results = await db.batch([db.prepare(GUARD), db.prepare(MEMBER).bind(actor)]);
      return { winner: results[0].meta.changes === 1 };
    } catch (error) {
      if (error instanceof D1IndeterminateError || error instanceof D1ContractProbeRefusedError) throw error;
      if (/UNIQUE/i.test(String(error))) return { winner: false };
      throw error;
    }
  };

  const judge = (winners, members) => {
    if (winners > 1) return "both-winners";
    if (winners === 1 && members === 1) return "one-winner";
    if (winners === 0) return "no-winner";
    return `one-winner-but-${members}-members`;
  };

  const observed = async () => ({
    bootstrapped: (await env.DB.prepare("SELECT bootstrapped FROM workspaces WHERE id = 1").first()).bootstrapped,
    members: (await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first()).n,
  });

  beforeEach(async () => {
    await env.DB.exec(
      "DROP TABLE IF EXISTS workspaces; DROP TABLE IF EXISTS members;"
      + " CREATE TABLE workspaces (id INTEGER PRIMARY KEY, bootstrapped INTEGER NOT NULL DEFAULT 0);"
      + " CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL UNIQUE, actor TEXT NOT NULL);"
      + " INSERT INTO workspaces (id, bootstrapped) VALUES (1, 0);",
    );
  });

  it("baseline: two sequential callers of a guarded batch yield exactly one winner", async () => {
    const controller = new ScenarioController({ id: "batch-baseline", perturbations: [] });
    const db = createD1FaultProxy(env.DB, { controller, target: "DB", process: "batch-test" });

    let winners = 0;
    for (const actor of ["ada", "grace"]) if ((await completeBootstrap(db, actor)).winner) winners += 1;

    const state = await observed();
    expect(judge(winners, state.members)).toBe("one-winner");
    expect(controller.history.snapshot().filter((e) => e.operation?.name === "d1.batch").length).toBeGreaterThanOrEqual(2);
  });

  it("a real batch that loses its response committed in full, and the blind retry is what breaks the invariant", async () => {
    const controller = new ScenarioController({
      id: "batch-response-lost",
      perturbations: [d1BatchCommitThenResponseLost("DB")],
    });
    const db = createD1FaultProxy(env.DB, { controller, target: "DB", process: "batch-test" });

    let winners = 0;
    await expect(completeBootstrap(db, "ada")).rejects.toThrow(/may have committed/i);
    if ((await completeBootstrap(db, "ada")).winner) winners += 1;

    const state = await observed();
    // Real D1 committed the whole first batch. The blind retry then hits the
    // UNIQUE constraint and rolls back, so the caller ends up with a *definite*
    // "bootstrap failed" for a bootstrap that succeeded.
    expect(state).toEqual({ bootstrapped: 1, members: 1 });
    expect(judge(winners, state.members)).toBe("no-winner");

    const info = controller.history.snapshot().find((e) => e.type === "info" && e.operation?.name === "d1.batch");
    expect(info.outcome).toMatchObject({ actual: "committed", observed: "indeterminate", actualSource: "declared" });
  });

  it("refuses partial batch application unless it is asked for, because real D1 batches are atomic", async () => {
    const controller = new ScenarioController({
      id: "batch-probe-refused",
      perturbations: [d1PartialBatchApplication("DB", 1)],
    });
    const db = createD1FaultProxy(env.DB, { controller, target: "DB", process: "batch-test" });

    await expect(completeBootstrap(db, "ada")).rejects.toThrow(D1ContractProbeRefusedError);
    expect(await observed()).toEqual({ bootstrapped: 0, members: 0 });
  });

  it("contract probe: a non-atomic batch leaves the guard consumed with no member row", async () => {
    const controller = new ScenarioController({
      id: "batch-probe",
      perturbations: [d1PartialBatchApplication("DB", 1)],
    });
    const db = createD1FaultProxy(env.DB, {
      controller,
      target: "DB",
      process: "batch-test",
      allowContractProbes: true,
    });

    let winners = 0;
    await expect(completeBootstrap(db, "ada")).rejects.toThrow(/may have committed/i);
    if ((await completeBootstrap(db, "grace")).winner) winners += 1;

    const state = await observed();
    // Real D1 cannot reach this state. It is here because the probe was enabled,
    // and it is exactly the state a non-atomic multi-statement backend would
    // leave behind: the guard is spent and its paired effect never happened.
    expect(state).toEqual({ bootstrapped: 1, members: 1 });
    expect(judge(winners, state.members)).toBe("no-winner");

    const parent = controller.history.snapshot().find((e) => e.type === "info" && e.operation?.name === "d1.batch");
    expect(parent.outcome.applied).toEqual([
      { index: 0, committed: true },
      { index: 1, committed: false, detail: "dropped by contract probe" },
    ]);
  });
});
