import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintOperationToken, RecordingOutcomeOracle, ScenarioController } from "@cloudfault/core";
import {
  createD1FaultProxy,
  createR2FaultProxy,
  d1BatchCommitThenResponseLost,
  d1CommitThenTimeout,
  d1PartialBatchApplication,
  D1ContractProbeRefusedError,
  D1IndeterminateError,
  r2CapacityError,
  r2CommitThenTimeout,
  r2MultipartCommitThenTimeout,
  r2PartialMultipartCompletion,
  r2PartUploadError,
  R2ContractProbeRefusedError,
  R2InjectedError,
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

/* --------------------------------------------------------------------------
 * R2, against genuine workerd bindings.
 *
 * Every assertion below is checked twice: once against the bucket (did the
 * object really appear, or really not?) and once against the history (was a
 * perturbation actually taken, and what did CloudFault claim about it?). A
 * fault that silently failed to fire would pass the first check and fail the
 * second, which is the whole point of asserting on both.
 * -------------------------------------------------------------------------- */

const events = (controller, name, type) =>
  controller.history.snapshot().filter((event) => event.type === type && event.operation?.name === name);
const event = (controller, name, type) => events(controller, name, type)[0];
const operationNames = (controller) =>
  controller.history.snapshot().filter((e) => e.type === "invoke").map((e) => e.operation.name);

describe("CloudFault against R2 reads and deletes", () => {
  it("labels a read as saying nothing about durability, and a delete as inferred-committed", async () => {
    await env.BUCKET.put("read-me.txt", "hello");
    const controller = new ScenarioController({ id: "r2-reads", perturbations: [] });
    const bucket = createR2FaultProxy(env.BUCKET, { controller, target: "BUCKET", process: "storage-test" });

    expect((await bucket.head("read-me.txt")).size).toBe(5);
    expect(await (await bucket.get("read-me.txt")).text()).toBe("hello");
    expect((await bucket.list()).objects.map((object) => object.key)).toEqual(["read-me.txt"]);
    await bucket.delete("read-me.txt");

    // The asymmetry is deliberate and is the thing under test: a read that
    // returned proves the response arrived, not that anything is durable.
    for (const name of ["r2.head", "r2.get", "r2.list"]) {
      expect(event(controller, name, "ok").outcome, name).toMatchObject({
        observed: "success",
        actual: "unknown",
        actualSource: "unknown",
      });
    }
    expect(event(controller, "r2.delete", "ok").outcome).toMatchObject({
      observed: "success",
      actual: "committed",
      actualSource: "inferred",
    });
    expect(await env.BUCKET.head("read-me.txt")).toBeNull();
  });

  it("injects a capacity error into the read path and leaves the object untouched", async () => {
    await env.BUCKET.put("read-me.txt", "hello");
    const fault = r2CapacityError("BUCKET", 503);
    const controller = new ScenarioController({ id: "r2-read-capacity", perturbations: [fault] });
    const bucket = createR2FaultProxy(env.BUCKET, { controller, target: "BUCKET", process: "storage-test" });

    await expect(bucket.get("read-me.txt")).rejects.toThrow(R2InjectedError);

    expect(controller.activationCount(fault.id)).toBe(1);
    expect(event(controller, "r2.get", "fail").outcome).toMatchObject({
      observed: "definite-failure",
      actual: "not-committed",
      actualSource: "declared",
    });
    expect(await (await env.BUCKET.get("read-me.txt")).text()).toBe("hello");
  });
});

describe("CloudFault against an R2 capacity error on the write path", () => {
  it("fails the put definitely, and the object is not in the bucket afterwards", async () => {
    const fault = r2CapacityError("BUCKET", 503);
    const controller = new ScenarioController({ id: "r2-capacity", perturbations: [fault] });
    const bucket = createR2FaultProxy(env.BUCKET, { controller, target: "BUCKET", process: "storage-test" });

    await expect(bucket.put("capacity.txt", "never lands")).rejects.toThrow(R2InjectedError);

    // The fault is before-commit, so this is the assertion that matters: the
    // application was told "definitely failed" and it definitely did.
    expect(await env.BUCKET.head("capacity.txt")).toBeNull();
    expect((await env.BUCKET.list()).objects).toEqual([]);

    expect(controller.activationCount(fault.id)).toBe(1);
    expect(controller.history.snapshot().some((e) => e.type === "fault" && e.tags.perturbationId === fault.id)).toBe(true);
    expect(event(controller, "r2.put", "fail").outcome).toMatchObject({
      observed: "definite-failure",
      actual: "not-committed",
      actualSource: "declared",
      detail: fault.description,
    });
  });
});

/**
 * Multipart, against genuine workerd R2 (Miniflare implements the whole
 * protocol, including the 5 MiB minimum size for every part but the last).
 *
 * A multipart upload is four separate round trips and only the last one makes
 * the object visible, so it is where partial-failure bugs live.
 */
describe("CloudFault against R2 multipart uploads", () => {
  // Every part but the last must clear R2's 5 MiB minimum, so a genuinely
  // multi-part upload has to move real bytes. Single-part uploads (the last
  // part is exempt) carry the cases that do not need a second part.
  const HEAD = "a".repeat(5 * 1024 * 1024);
  const TAIL = "b".repeat(64);

  const proxy = (controller, options = {}) =>
    createR2FaultProxy(env.BUCKET, { controller, target: "BUCKET", process: "storage-test", ...options });

  it("instruments create, uploadPart and complete rather than letting the handle escape", async () => {
    const controller = new ScenarioController({ id: "mpu-baseline", perturbations: [] });
    const bucket = proxy(controller);

    const upload = await bucket.createMultipartUpload("baseline.bin");
    // The handle is wrapped, and its native accessors still work through it.
    expect(upload.key).toBe("baseline.bin");
    expect(typeof upload.uploadId).toBe("string");
    const part = await upload.uploadPart(1, TAIL);
    const object = await upload.complete([part]);

    expect(object.size).toBe(TAIL.length);
    expect(await (await env.BUCKET.get("baseline.bin")).text()).toBe(TAIL);
    expect(operationNames(controller)).toEqual([
      "r2.createMultipartUpload",
      "r2.uploadPart",
      "r2.completeMultipartUpload",
    ]);
    expect(event(controller, "r2.uploadPart", "ok").operation.resource).toBe("baseline.bin#1");
    expect(event(controller, "r2.completeMultipartUpload", "ok").outcome).toMatchObject({
      observed: "success",
      actual: "committed",
      actualSource: "inferred",
    });
  });

  it("instruments a resumed upload's parts too", async () => {
    const controller = new ScenarioController({ id: "mpu-resume", perturbations: [] });
    const bucket = proxy(controller);

    // `resumeMultipartUpload` is synchronous and does no I/O, so it records no
    // operation. What it must do is hand back an instrumented handle.
    const created = await env.BUCKET.createMultipartUpload("resumed.bin");
    const resumed = bucket.resumeMultipartUpload("resumed.bin", created.uploadId);
    const part = await resumed.uploadPart(1, TAIL);
    await resumed.complete([part]);

    expect(await (await env.BUCKET.get("resumed.bin")).text()).toBe(TAIL);
    expect(operationNames(controller)).toEqual(["r2.uploadPart", "r2.completeMultipartUpload"]);
  });

  it("models a multipart upload that completed before the caller lost the result", async () => {
    const fault = r2MultipartCommitThenTimeout("BUCKET");
    const controller = new ScenarioController({ id: "mpu-ambiguous", perturbations: [fault] });
    const bucket = proxy(controller);

    const upload = await bucket.createMultipartUpload("ambiguous.bin");
    const parts = [await upload.uploadPart(1, HEAD), await upload.uploadPart(2, TAIL)];
    await expect(upload.complete(parts)).rejects.toThrow(/may have committed/i);

    // It committed. Exactly like the single-shot `put` case, the object is
    // really there and the caller has no way to know it.
    const object = await env.BUCKET.get("ambiguous.bin");
    expect(object).not.toBeNull();
    expect(object.size).toBe(HEAD.length + TAIL.length);

    expect(controller.activationCount(fault.id)).toBe(1);
    expect(event(controller, "r2.completeMultipartUpload", "info").outcome).toMatchObject({
      observed: "indeterminate",
      actual: "committed",
      actualSource: "declared",
    });

    // And the caller's natural recovery makes it worse: aborting an upload that
    // already completed succeeds and does not remove the object.
    await upload.abort();
    expect(await env.BUCKET.head("ambiguous.bin")).not.toBeNull();
  });

  it("fails one part before it lands, and nothing becomes visible under the key", async () => {
    const fault = r2PartUploadError("BUCKET", "partial.bin", 2);
    const controller = new ScenarioController({ id: "mpu-part-failure", perturbations: [fault] });
    const bucket = proxy(controller);

    const upload = await bucket.createMultipartUpload("partial.bin");
    await upload.uploadPart(1, HEAD);
    await expect(upload.uploadPart(2, TAIL)).rejects.toThrow(R2InjectedError);

    expect(controller.activationCount(fault.id)).toBe(1);
    expect(events(controller, "r2.uploadPart", "ok")).toHaveLength(1);
    const failed = event(controller, "r2.uploadPart", "fail");
    expect(failed.operation.resource).toBe("partial.bin#2");
    expect(failed.outcome).toMatchObject({
      observed: "definite-failure",
      actual: "not-committed",
      actualSource: "declared",
    });

    // Part 1 is durably stored and billable, but `complete` never ran, so the
    // key holds nothing at all.
    expect(await env.BUCKET.head("partial.bin")).toBeNull();
    expect((await env.BUCKET.list()).objects).toEqual([]);
  });

  it("refuses a partial completion unless it is asked for, because real R2 completes atomically", async () => {
    const controller = new ScenarioController({
      id: "mpu-probe-refused",
      perturbations: [r2PartialMultipartCompletion("BUCKET", 1)],
    });
    const bucket = proxy(controller);

    const upload = await bucket.createMultipartUpload("probe.bin");
    const parts = [await upload.uploadPart(1, "first"), await upload.uploadPart(2, "second")];
    await expect(upload.complete(parts)).rejects.toThrow(R2ContractProbeRefusedError);

    // Refused before dispatch: `complete` never ran, so nothing materialised.
    expect(await env.BUCKET.head("probe.bin")).toBeNull();
  });

  it("contract probe: the object materialises from a prefix of the parts the caller listed", async () => {
    const fault = r2PartialMultipartCompletion("BUCKET", 1);
    const controller = new ScenarioController({ id: "mpu-probe", perturbations: [fault] });
    const bucket = proxy(controller, { allowContractProbes: true });

    const upload = await bucket.createMultipartUpload("probe.bin");
    const parts = [await upload.uploadPart(1, "first"), await upload.uploadPart(2, "second")];
    await expect(upload.complete(parts)).rejects.toThrow(/may have committed/i);

    // Real R2 cannot reach this state. It is here because the probe was
    // enabled, and it is exactly what a backend with non-atomic completion
    // leaves behind: an object that looks complete and is short.
    expect(await (await env.BUCKET.get("probe.bin")).text()).toBe("first");

    expect(controller.activationCount(fault.id)).toBe(1);
    const info = event(controller, "r2.completeMultipartUpload", "info");
    expect(info.outcome).toMatchObject({ actual: "committed", observed: "indeterminate", actualSource: "declared" });
    expect(info.outcome.applied).toEqual([
      { index: 0, committed: true, detail: undefined },
      { index: 1, committed: false, detail: "dropped by contract probe" },
    ]);
  });
});

/**
 * The oracle seam on R2.
 *
 * `env.BUCKET` has no response headers, so the correlation token travels
 * through whatever the caller wires up. Here a privileged shim in front of the
 * binding records what really happened *after* the write is durable and before
 * CloudFault destroys the response — which is the only way an attempt whose
 * response was deliberately destroyed stays answerable.
 */
describe("CloudFault against an R2 outcome oracle", () => {
  it("records what the storage side knows rather than what the proxy could deduce", async () => {
    const oracle = new RecordingOutcomeOracle("r2-storage");
    let pending;
    const privileged = {
      ...env.BUCKET,
      head: (key) => env.BUCKET.head(key),
      get: (key, options) => env.BUCKET.get(key, options),
      list: (options) => env.BUCKET.list(options),
      delete: (keys) => env.BUCKET.delete(keys),
      async put(key, value, options) {
        const object = await env.BUCKET.put(key, value, options);
        // Durable now. Recorded from the storage side, never from a status.
        oracle.record(pending, {
          actual: "committed",
          version: oracle.bumpVersion(`r2:${key}`),
          evidence: { etag: object.etag, size: object.size },
        });
        return object;
      },
    };

    const controller = new ScenarioController({
      id: "r2-oracle",
      perturbations: [r2CommitThenTimeout("BUCKET")],
    });
    const bucket = createR2FaultProxy(privileged, {
      controller,
      target: "BUCKET",
      process: "storage-test",
      oracle,
      token: () => (pending = mintOperationToken()),
    });

    await expect(bucket.put("asked.txt", "committed")).rejects.toThrow(/may have committed/i);

    expect(await (await env.BUCKET.get("asked.txt")).text()).toBe("committed");
    const info = event(controller, "r2.put", "info");
    // Without an oracle this same event reads `actualSource: "declared"` — the
    // fault's own claim. Here the storage side was asked and answered.
    expect(info.outcome.actualSource).toBe("oracle");
    expect(info.outcome.actual).toBe("committed");
    expect(info.outcome.version).toBe(1);
    expect(info.outcome.evidence).toMatchObject({ size: 9 });
    expect(info.operation.token).toBe(pending);
  });
});
