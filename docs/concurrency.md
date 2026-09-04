# Concurrency: what CloudFault schedules, and what it does not

CloudFault has always **recorded** interleavings. `runConcurrentWorkload()` runs
each logical client as its own async sequence and says so in its own doc
comment: *"this intentionally does not claim deterministic scheduling: it
records the schedule that happened."* That is honest, and it is also weak. A
race that needs a specific interleaving shows up whenever the event loop
happens to produce it, which in practice means rarely, non-reproducibly, and
usually not in CI.

`exploreInterleavings()` closes part of that gap. It does not close all of it,
and this document is about the part it leaves open.

## What it does

Actors declare their own suspension points:

```ts
const bootstrap = (db, actor) => async (context) => {
  const row = await db.prepare("SELECT bootstrapped FROM workspaces WHERE id = 1").first();
  await context.yield("after-read");        // <- a declared suspension point
  if (row.bootstrapped === 1) return { winner: false };
  await db.batch([db.prepare(GUARD), db.prepare(MEMBER).bind(actor)]);
  return { winner: true };
};
```

`exploreInterleavings()` then discovers how many points each actor reaches,
enumerates every ordering of them, and replays each one deterministically:

```ts
const exploration = await exploreInterleavings({
  setup: () => ({ state, actors: [{ name: "ada", run: … }, { name: "grace", run: … }] }),
  check: ({ state, results }) => exactlyOneBootstrap(state, results),
});

exploration.failures[0].schedule;   // ["ada", "grace"] — replays as-is
```

At most one actor runs at a time, and everything between two `yield()` calls is
atomic with respect to the other actors. A failing schedule is therefore a plain
array of actor names: it re-runs, it minimizes, and it goes in a failure
artifact like any other witness.

An interleaving is modelled as a `SemanticVariation`, not a `Fault`. Nothing
failed. The provider committed, the transport delivered, and the application is
wrong anyway — which is the distinction the whole legal-semantics/degradation
split exists to preserve.

The result is two-sided, and the second side is the one that pays for the
feature in day-to-day use:

- a **failure** is a concrete replayable schedule that breaks the invariant;
- **no failure** across a complete enumeration is a real statement — *no
  ordering of the points you declared breaks this* — which is what you want
  after fixing a race, and what a recorded run can never give you.

## What it does not do, stated plainly

1. **Only declared suspension points.** Every real `await` is a suspension
   point; this explores the ones an author marked. It finds bugs; it does not
   prove their absence. This is the big one, and it is deliberate: discovering
   suspension points automatically means instrumenting or transforming the code
   under test, which is a different kind of project.
2. **No partial-order reduction.** Independent operations are interleaved
   anyway. Two actors with n and m points give C(n+m, n) schedules; three or
   more give the multinomial. `maxSchedules` (default 64) is a hard bound and
   `enumeration.truncated` reports when it bit. There is no claim of coverage
   past that point.
3. **Yield counts come from a probe run.** An actor whose number of suspension
   points depends on what it observed can diverge from the planned schedule.
   That is detected and reported as `divergent`, never absorbed as if the plan
   had been followed.
4. **One isolate.** This schedules cooperating async actors inside a single
   JavaScript isolate. It does not model two workerd isolates, two colos, two
   Durable Object instances, or the storage engine's own internal concurrency.
   A D1 write that is atomic here is atomic because the fixture or the runtime
   made it so, not because the scheduler enforced it.

## Why not a model checker

The obvious next step is to stop asking authors to declare suspension points and
instead treat every `await` as one. That is where this stops, and the reasons
are worth writing down rather than leaving as an unexplained gap.

- **Interception.** Making every `await` a scheduling decision means owning the
  microtask queue. In Node that is a custom promise implementation or an async
  hooks scheme; in workerd it is neither, because the runtime's I/O completions
  are not JavaScript-observable. CloudFault's tenth principle is "do not fork
  workerd", and a scheduler that must control workerd's event loop is a fork in
  all but name.
- **State-space size.** Even with full interception, the interesting programs
  have thousands of suspension points. Useful exploration then requires
  partial-order reduction (identify commuting operations and skip equivalent
  interleavings), which requires a happens-before relation over storage
  operations, which requires modelling what D1, KV, R2 and Durable Objects
  actually guarantee about concurrent access — per primitive, and with evidence.
  That is a research programme, not a feature.
- **The payoff curve is flat early.** The overwhelming majority of Workers
  concurrency bugs are read-then-write races across a single logical await, and
  bounded two-actor exploration over declared points catches those. Going from
  "catches the common shape" to "sound" costs orders of magnitude more than
  going from "records what happened" to "catches the common shape" did.

So the honest position is: this is a scoped model, it is useful, and it is
labelled. If CloudFault ever needs soundness, the shape is a deterministic
promise scheduler plus a happens-before model per Cloudflare primitive plus
partial-order reduction — and that should be a separate, evidence-backed
project rather than something smuggled in behind an API that already looks like
it works.
