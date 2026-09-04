import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const core = await import(pathToFileURL(path.join(process.cwd(), "packages/core/dist/index.js")));
const cloudflare = await import(pathToFileURL(path.join(process.cwd(), "packages/cloudflare/dist/index.js")));

/**
 * A D1-shaped fixture with the one property that matters here: `batch()` is
 * ATOMIC, exactly as real D1 is. It snapshots, applies, and rolls back on
 * error, so any partial application observed in these tests came from
 * CloudFault's contract probe and could not have come from the backend.
 */
class FakeD1 {
  constructor() {
    this.state = { bootstrapped: 0, members: [] };
    this.batchCalls = 0;
    this.statementRuns = 0;
  }

  prepare(sql) {
    return new FakeStatement(this, sql, []);
  }

  async batch(statements) {
    this.batchCalls += 1;
    const snapshot = structuredClone(this.state);
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }
}

class FakeStatement {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeStatement(this.db, this.sql, params);
  }

  async run() {
    this.db.statementRuns += 1;
    const state = this.db.state;
    if (this.sql.startsWith("UPDATE workspace")) {
      const changes = state.bootstrapped === 0 ? 1 : 0;
      state.bootstrapped = 1;
      return { success: true, meta: { changes } };
    }
    if (this.sql.startsWith("INSERT INTO members")) {
      state.members.push(this.params[0]);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`fixture does not understand: ${this.sql}`);
  }
}

const BOOTSTRAP_GUARD = "UPDATE workspace SET bootstrapped = 1 WHERE id = 1 AND bootstrapped = 0";
const BOOTSTRAP_MEMBER = "INSERT INTO members (workspace_id, actor) VALUES (1, ?)";

/**
 * The shape every guarded write in a Workers/D1 app takes, and the shape
 * `@effect/sql-d1` compiles to: one `batch()` whose first statement is the
 * guard and whose remaining statements are the effects that may only happen if
 * the guard won. Reachable by CloudFault only because `batch()` is interposed.
 */
async function completeBootstrap(db, actor) {
  const results = await db.batch([
    db.prepare(BOOTSTRAP_GUARD),
    db.prepare(BOOTSTRAP_MEMBER).bind(actor),
  ]);
  return { winner: results[0].meta.changes === 1 };
}

/** The invariant, stated so it distinguishes all three ways this can go wrong. */
function judgeBootstrap(state, winners) {
  if (winners > 1) return { verdict: "both-winners", valid: false };
  if (winners === 1 && state.members.length === 1) return { verdict: "one-winner", valid: true };
  if (winners === 0) return { verdict: "no-winner", valid: false };
  return { verdict: `one-winner-but-${state.members.length}-members`, valid: false };
}

function proxyFor(db, perturbations, options = {}) {
  const controller = new core.ScenarioController({ id: "batch", perturbations });
  return {
    controller,
    db: cloudflare.createD1FaultProxy(db, { controller, target: "DB", process: "app", ...options }),
  };
}

test("batch() reaches the native atomic call with unwrapped statements", async () => {
  const backing = new FakeD1();
  const { db, controller } = proxyFor(backing, []);

  const result = await completeBootstrap(db, "ada");

  assert.equal(result.winner, true);
  assert.equal(backing.batchCalls, 1, "the native batch path must be used when nothing is injected");
  const events = controller.history.snapshot();
  const completion = events.find((event) => event.operation?.name === "d1.batch" && event.type === "ok");
  assert.ok(completion, "batch must appear in the history as its own logical operation");
  assert.equal(completion.outcome.actual, "committed");
  assert.equal(completion.outcome.actualSource, "inferred", "no oracle was configured, so this is a deduction");
  assert.deepEqual(completion.outcome.applied, [
    { index: 0, committed: true },
    { index: 1, committed: true },
  ]);
});

test("batch() hands the runtime the real statements, not the fault proxies", async () => {
  const backing = new FakeD1();
  let seen;
  const original = backing.batch.bind(backing);
  backing.batch = async (statements) => {
    seen = statements;
    return original(statements);
  };
  const { db } = proxyFor(backing, []);
  await completeBootstrap(db, "ada");

  // Going through a Proxy, `run` resolves to a fresh interposing closure. The
  // prototype method identity holding proves the statements were unwrapped —
  // workerd reads internal state off a real D1PreparedStatement and a Proxy in
  // front of it is not a safe substitute.
  assert.equal(seen.length, 2);
  for (const statement of seen) {
    assert.equal(statement.run, FakeStatement.prototype.run, "batch received a proxied statement");
  }
});

test("a fault before commit leaves the batch entirely unapplied", async () => {
  const backing = new FakeD1();
  const { db, controller } = proxyFor(backing, [cloudflare.d1BatchRejectBeforeCommit("DB")]);

  await assert.rejects(() => completeBootstrap(db, "ada"), /injected D1 fault 'reject-before-commit'/);
  assert.equal(backing.batchCalls, 0, "the batch must never reach storage");
  assert.deepEqual(backing.state, { bootstrapped: 0, members: [] });

  const completion = controller.history.snapshot().find((event) => event.type === "fail" && event.operation?.name === "d1.batch");
  assert.equal(completion.outcome.actual, "not-committed");
  assert.equal(completion.outcome.observed, "definite-failure");
});

test("a batch that commits and then loses its response is indeterminate, and a blind retry duplicates", async () => {
  const backing = new FakeD1();
  const { db, controller } = proxyFor(backing, [cloudflare.d1BatchCommitThenResponseLost("DB")]);

  let winners = 0;
  try {
    if ((await completeBootstrap(db, "ada")).winner) winners += 1;
  } catch (error) {
    assert.ok(error instanceof cloudflare.D1IndeterminateError);
    // The application does what applications do: it cannot tell, so it retries.
    if ((await completeBootstrap(db, "ada")).winner) winners += 1;
  }

  assert.equal(backing.batchCalls, 2);
  assert.equal(backing.state.bootstrapped, 1);
  assert.deepEqual(judgeBootstrap(backing.state, winners), {
    verdict: "no-winner",
    valid: false,
  }, "the guard was consumed by an attempt whose result the caller never saw");
  assert.equal(backing.state.members.length, 2, "the unconditional insert ran twice");

  const info = controller.history.snapshot().find((event) => event.type === "info" && event.operation?.name === "d1.batch");
  assert.equal(info.outcome.actual, "committed");
  assert.equal(info.outcome.observed, "indeterminate");
  // CloudFault chose the moment of failure itself, after a call that returned,
  // so "committed" here is declared by the fault rather than asked of anyone.
  assert.equal(info.outcome.actualSource, "declared");
});

test("a batch that commits and then reports an error gives the application a definite wrong answer", async () => {
  const backing = new FakeD1();
  const { db, controller } = proxyFor(backing, [cloudflare.d1BatchErrorAfterCommit("DB")]);

  await assert.rejects(() => completeBootstrap(db, "ada"), cloudflare.D1InjectedError);
  assert.equal(backing.state.bootstrapped, 1, "the batch really committed");

  const completion = controller.history.snapshot().find((event) => event.type === "fail" && event.operation?.name === "d1.batch");
  assert.equal(completion.outcome.actual, "committed");
  assert.equal(completion.outcome.observed, "definite-failure");
});

test("partial batch application is refused unless it is explicitly enabled", async () => {
  const backing = new FakeD1();
  const { db } = proxyFor(backing, [cloudflare.d1PartialBatchApplication("DB", 1)]);

  await assert.rejects(
    () => completeBootstrap(db, "ada"),
    (error) => {
      assert.ok(error instanceof cloudflare.D1ContractProbeRefusedError);
      assert.match(error.message, /real D1 batches are atomic/);
      return true;
    },
  );
  assert.equal(backing.statementRuns, 0, "a refused probe must not touch storage");
  assert.ok(cloudflare.D1_CONTRACT_PROBE_KINDS.has("partial-batch-application"));
});

test("partial batch application, once enabled, exposes the atomicity assumption", async () => {
  const backing = new FakeD1();
  const { db, controller } = proxyFor(
    backing,
    [cloudflare.d1PartialBatchApplication("DB", 1)],
    { allowContractProbes: true },
  );

  let winners = 0;
  await assert.rejects(() => completeBootstrap(db, "ada"), cloudflare.D1IndeterminateError);
  // Blind retry, the same as above.
  if ((await completeBootstrap(db, "ada")).winner) winners += 1;

  // Real D1 could not produce this state: the guard flipped while its paired
  // insert did not run. It is here only because the probe was asked for.
  assert.equal(backing.state.bootstrapped, 1);
  assert.deepEqual(judgeBootstrap(backing.state, winners), { verdict: "no-winner", valid: false });
  assert.deepEqual(backing.state.members, ["ada"], "only the retry's insert landed");

  const events = controller.history.snapshot();
  const parent = events.find((event) => event.type === "info" && event.operation?.name === "d1.batch");
  assert.deepEqual(parent.outcome.applied, [
    { index: 0, committed: true },
    { index: 1, committed: false, detail: "dropped by contract probe" },
  ]);
  const children = events.filter((event) => event.operation?.name === "d1.batch.statement" && event.type !== "invoke");
  assert.deepEqual(children.map((event) => [event.operation.statementIndex, event.type]), [[0, "ok"], [1, "fail"]]);
  assert.equal(children[0].operation.parentId, parent.operation.id);
});

test("a statement-level selector chooses where the batch is cut", async () => {
  const backing = new FakeD1();
  const { controller, db } = proxyFor(
    backing,
    [cloudflare.d1PartialBatchApplication("DB", 2)],
    { allowContractProbes: true },
  );

  await assert.rejects(
    () => db.batch([
      db.prepare(BOOTSTRAP_GUARD),
      db.prepare(BOOTSTRAP_MEMBER).bind("ada"),
      db.prepare(BOOTSTRAP_MEMBER).bind("grace"),
    ]),
    cloudflare.D1IndeterminateError,
  );

  assert.deepEqual(backing.state, { bootstrapped: 1, members: ["ada"] });
  const parent = controller.history.snapshot().find((event) => event.type === "info" && event.operation?.name === "d1.batch");
  assert.deepEqual(parent.outcome.applied.map((entry) => entry.committed), [true, true, false]);
});

test("the fault space distinguishes real D1 outcomes from the contract probe", () => {
  const real = [
    cloudflare.d1BatchRejectBeforeCommit("DB"),
    cloudflare.d1BatchCommitThenResponseLost("DB"),
    cloudflare.d1BatchErrorAfterCommit("DB"),
  ];
  for (const fault of real) {
    assert.equal(cloudflare.D1_CONTRACT_PROBE_KINDS.has(fault.kind), false, `${fault.kind} must not be a probe`);
    assert.equal(fault.operation, "d1.batch");
  }
  const probe = cloudflare.d1PartialBatchApplication("DB", 1);
  assert.equal(probe.metadata.contractProbe, true);
  assert.match(probe.description, /CONTRACT PROBE \(real D1 batches are atomic\)/);
});
