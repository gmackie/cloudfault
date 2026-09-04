import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const core = await import(pathToFileURL(path.join(process.cwd(), "packages/core/dist/index.js")));
const cloudflare = await import(pathToFileURL(path.join(process.cwd(), "packages/cloudflare/dist/index.js")));

/**
 * An atomic-batch D1 fixture that also models SQLite's `changes()`, because the
 * correct fix below depends on it: a conditional INSERT that only fires when the
 * guard UPDATE actually changed a row. `lastChanges` is per-connection state,
 * which is sound here for the same reason it is sound in real D1 -- the
 * statements of one batch run consecutively on one connection.
 */
class FakeD1 {
  constructor() {
    this.state = { bootstrapped: 0, members: [] };
    this.lastChanges = 0;
  }

  prepare(sql) {
    const db = this;
    return {
      sql,
      params: [],
      bind(...params) { return { ...this, params }; },
      async first() {
        if (this.sql.startsWith("SELECT bootstrapped")) return { bootstrapped: db.state.bootstrapped };
        throw new Error(`fixture does not understand: ${this.sql}`);
      },
      async run() {
        if (this.sql.startsWith("UPDATE workspace")) {
          const changes = db.state.bootstrapped === 0 ? 1 : 0;
          db.state.bootstrapped = 1;
          db.lastChanges = changes;
          return { success: true, meta: { changes } };
        }
        if (this.sql.startsWith("INSERT INTO members")) {
          const conditional = this.sql.includes("changes() = 1");
          const changes = conditional && db.lastChanges !== 1 ? 0 : 1;
          if (changes === 1) db.state.members.push(this.params[0]);
          db.lastChanges = changes;
          return { success: true, meta: { changes } };
        }
        throw new Error(`fixture does not understand: ${this.sql}`);
      },
    };
  }

  // Real D1 batches are atomic: all statements commit or none do.
  async batch(statements) {
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

const GUARD = "UPDATE workspace SET bootstrapped = 1 WHERE id = 1 AND bootstrapped = 0";
const MEMBER = "INSERT INTO members (workspace_id, actor) SELECT 1, ?1 WHERE changes() = 1";
const READ = "SELECT bootstrapped FROM workspace WHERE id = 1";

/**
 * The version everybody writes first: read the flag, decide, then write. The
 * decision and the write are not one atomic step, and the gap between them is
 * exactly one `await`.
 */
function unsafeBootstrap(db, actor) {
  return async (context) => {
    const row = await db.prepare(READ).first();
    await context.yield("after-read");
    if (row.bootstrapped === 1) return { winner: false };
    // The batch itself is atomic and correctly guarded. The bug is entirely in
    // the decision above it: the read that justified this write is already
    // stale, and the caller reports success on the strength of it.
    await db.batch([db.prepare(GUARD), db.prepare(MEMBER).bind(actor)]);
    return { winner: true };
  };
}

/**
 * The fix: no read-then-decide. The guard is the write, the row count it
 * reports is the decision, and the member INSERT is itself conditional on that
 * count. Correct under every interleaving *because* real D1 batches are atomic.
 */
function guardedBootstrap(db, actor) {
  return async (context) => {
    await context.yield("before-write");
    const results = await db.batch([db.prepare(GUARD), db.prepare(MEMBER).bind(actor)]);
    return { winner: results[0].meta.changes === 1 };
  };
}

/** The invariant, distinguishing all three ways two concurrent callers can go. */
function judge(state, results) {
  const winners = results.filter((result) => result.status === "ok" && result.value?.winner).length;
  if (winners > 1) return { valid: false, checker: "exactly-one-bootstrap", message: "both-winners", details: { winners, members: state.members } };
  if (winners === 0) return { valid: false, checker: "exactly-one-bootstrap", message: "no-winner", details: { winners, members: state.members } };
  if (state.members.length !== 1) {
    return { valid: false, checker: "exactly-one-bootstrap", message: `one-winner-but-${state.members.length}-members`, details: { winners, members: state.members } };
  }
  return { valid: true, checker: "exactly-one-bootstrap", details: { winners } };
}

function scenario(build) {
  return {
    setup() {
      const db = new FakeD1();
      const controller = new core.ScenarioController({ id: "interleaving", perturbations: [] });
      const proxied = cloudflare.createD1FaultProxy(db, { controller, target: "DB", process: "app" });
      return {
        state: db.state,
        actors: [
          { name: "ada", run: build(proxied, "ada") },
          { name: "grace", run: build(proxied, "grace") },
        ],
      };
    },
    check: ({ state, results }) => judge(state, results),
  };
}

test("enumerateSchedules produces every ordering of the declared points", () => {
  const two = core.enumerateSchedules({ a: 1, b: 1 });
  assert.deepEqual(two.schedules, [["a", "b"], ["b", "a"]]);
  assert.equal(two.total, 2);
  assert.equal(two.truncated, false);

  const wider = core.enumerateSchedules({ a: 2, b: 2 });
  assert.equal(wider.total, 6, "C(4,2)");
  assert.equal(wider.schedules.length, 6);

  const capped = core.enumerateSchedules({ a: 3, b: 3 }, { maxSchedules: 4 });
  assert.equal(capped.total, 20);
  assert.equal(capped.schedules.length, 4);
  assert.equal(capped.truncated, true, "truncation must be reported, not silently absorbed");
});

test("one schedule replays deterministically", async () => {
  const log = [];
  const actor = (name) => ({
    name,
    async run(context) {
      log.push(`${name}:start`);
      await context.yield("mid");
      log.push(`${name}:end`);
      return name;
    },
  });

  const run = await core.runInterleaving([actor("a"), actor("b")], ["b", "a"]);
  assert.deepEqual(run.observed, ["b", "a"]);
  assert.deepEqual(run.labels, ["mid", "mid"]);
  assert.equal(run.divergent, false);
  // Both actors reach their first suspension point before either resumes:
  // the code between two yields is atomic with respect to the other actor.
  assert.deepEqual(log, ["a:start", "b:start", "b:end", "a:end"]);
  assert.deepEqual(run.results.map((result) => result.value), ["a", "b"]);
});

test("exploring interleavings finds the read-then-write race that a recorded run can miss", async () => {
  const exploration = await core.exploreInterleavings({
    ...scenario(unsafeBootstrap),
    stopOnFirstFailure: false,
  });

  assert.deepEqual(exploration.yieldPoints, { ada: 1, grace: 1 });
  assert.equal(exploration.enumeration.total, 2);
  assert.deepEqual(exploration.divergent, []);

  // Both callers read the guard before either wrote it, so both report having
  // won the bootstrap. Note where the damage is: the *database* is fine -- one
  // member row, atomically guarded -- and the application still told two
  // callers they were the one. This is exactly the failure a run that merely
  // records whatever interleaving occurred will miss most of the time.
  assert.ok(exploration.failures.length > 0, "the race must be found");
  const failure = exploration.failures[0];
  assert.equal(failure.check.message, "both-winners");
  assert.equal(failure.check.details.winners, 2);
  assert.deepEqual(failure.state.members, ["ada"], "the database stayed correct; the application did not");
  // A plain array of actor names: the witness replays as-is.
  assert.deepEqual(failure.schedule, ["ada", "grace"]);

  const replay = await core.exploreInterleavings({
    ...scenario(unsafeBootstrap),
    yieldPoints: { ada: 1, grace: 1 },
    maxSchedules: 1,
  });
  assert.equal(replay.outcomes[0].check.message, "both-winners");
});

test("the guarded version survives every enumerated ordering", async () => {
  const exploration = await core.exploreInterleavings({
    ...scenario(guardedBootstrap),
    stopOnFirstFailure: false,
  });

  assert.deepEqual(exploration.failures, []);
  assert.equal(exploration.enumeration.truncated, false);
  assert.deepEqual(exploration.divergent, []);
  // The statement this licenses is bounded but real: no ordering of the
  // suspension points these actors declared breaks the invariant.
  assert.equal(exploration.outcomes.length, 2);
  for (const outcome of exploration.outcomes) {
    assert.equal(outcome.check.valid, true);
    assert.deepEqual(outcome.state.members.length, 1);
  }
});

test("a schedule is legal behaviour, so it is a SemanticVariation and not a Fault", async () => {
  const controller = new core.ScenarioController({ id: "recorded", perturbations: [] });
  await core.exploreInterleavings({
    ...scenario(guardedBootstrap),
    controller,
    stopOnFirstFailure: false,
  });

  const recorded = controller.history.snapshot().filter((event) => event.type === "semantic");
  assert.equal(recorded.length, 2);
  assert.equal(recorded.every((event) => event.tags.kind === "interleaving"), true);
  assert.equal(recorded.some((event) => "phase" in event.value), false, "an interleaving has no fault phase");

  const variation = core.scheduleVariation(["ada", "grace"]);
  assert.equal(variation.kind, "interleaving");
  assert.deepEqual(variation.metadata.schedule, ["ada", "grace"]);
});

test("a divergent actor is reported, never passed off as the planned schedule", async () => {
  // `grace` suspends twice, but the plan only accounts for one point each, so
  // the scheduler has to improvise -- and says so.
  const actors = [
    { name: "ada", async run(context) { await context.yield("a1"); return 1; } },
    { name: "grace", async run(context) { await context.yield("g1"); await context.yield("g2"); return 2; } },
  ];
  const run = await core.runInterleaving(actors, ["ada", "grace"]);
  assert.equal(run.divergent, true);
  assert.deepEqual(run.observed, ["ada", "grace", "grace"]);
  assert.deepEqual(run.labels, ["a1", "g1", "g2"]);
});

test("a schedule that cannot make progress fails loudly instead of hanging", async () => {
  const actors = [
    { name: "ada", async run() { await new Promise(() => {}); } },
    { name: "grace", async run(context) { await context.yield(); } },
  ];
  await assert.rejects(
    () => core.runInterleaving(actors, ["grace"], { timeoutMs: 50 }),
    /deadlocked: ada never reached a suspension point/,
  );
});
