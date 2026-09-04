# Architecture

CloudFault is a systematic resilience and distributed-correctness test system for applications composed from Cloudflare primitives and external APIs.

## Design lineage

CloudFault intentionally borrows established abstractions:

- **Jepsen** — logical `invoke` / `ok` / `fail` / `info` histories and correctness models.
- **Filibuster / LDFI** — identify dependency calls and systematically inject failures rather than relying only on random chaos.
- **Distributed Execution Indexing** — stable dynamic call identity across repeated executions.
- **FaultWeave** — bounded multi-fault exploration and minimal failure diagnosis.
- **Cast** — deep state assertions instead of treating a successful top-level response as sufficient evidence of correctness.
- **fast-check** — generated workloads, shrinking, replay, and scheduling experiments.
- **Cloudflare Test Harness / Miniflare / workerd** — production-shaped Worker execution and low-level event dispatch.
- **emulate / provider sandboxes** — optional stateful happy-path provider implementations under CloudFault's hostile semantic layer.

## Layers

```text
                  test / workload model
                         |
                         v
                systematic explorer
                         |
                Scenario + perturbations
                         |
          +--------------+---------------+
          |                              |
          v                              v
  Cloudflare semantic pack       provider adapter registry
          |                              |
          v                              v
 binding nemesis workers          AdapterRuntime / MSW
          |                              |
          +--------------+---------------+
                         |
                  Worker under workerd
                         |
                         v
                       state
                         |
             history + business checkers
                         |
                 failure minimizer
                         |
              replayable artifact
```

## Perturbations

CloudFault has two classes of perturbation.

### Semantic variation

A behavior allowed by the dependency contract, such as:

- a KV observer seeing an older version;
- a cached negative KV lookup;
- duplicate Queue delivery;
- altered Queue batch boundaries;
- a lagging D1 replica view; or
- duplicate/delayed scheduled execution.

These are intentionally not described as provider failures.

### Fault

A degraded or failed operation such as:

- transient D1/R2/service unavailability;
- rate limiting;
- timeout before send;
- rejection before commit;
- response loss after an external commit; or
- malformed/truncated response data.

Each fault has a phase and, where meaningful, an actual and observed outcome.

## Outcome ambiguity

```text
actual outcome        caller observation
--------------        ------------------
committed             success
not committed         definite failure
committed             indeterminate
unknown               indeterminate
```

When an emulated provider commits a side effect and CloudFault drops the response, the history can record privileged reality (`actual=committed`) while the application receives only the indeterminate network failure. When proxying a real provider and CloudFault cannot establish reality, `actual=unknown` remains honest.

## The privileged oracle

`actual` is only worth recording if it was *established*. `OutcomeOracle`
(`@gmacko/cloudfault`) is the seam that establishes it:

```ts
interface OutcomeOracle {
  readonly name?: string;
  outcomeFor(token: OperationToken): Promise<PrivilegedOutcome | undefined>;
  versionOf?(resource: string): Promise<number | undefined>;
  snapshot?(): Promise<unknown>;
  reset?(): Promise<void>;
}

interface PrivilegedOutcome {
  actual: ActualOutcome;                       // the provider's own answer
  observed?: ObservedOutcome;                  // what it let the caller see
  version?: number;                            // provider-side commit ordering
  applied?: readonly AppliedSubOperation[];    // which sub-operations landed
  evidence?: Record<string, unknown>;          // rows_written, etag, changes...
}
```

**The token is caller-minted.** CloudFault mints it before the request goes out
and sends it on `x-emulate-operation`; the backend records against it *after*
the effect is durable. This is not a detail: under `commit-then-response-lost`
there is no response to read a correlation id off, so a response-minted token
could not answer the only question worth asking.

**An oracle that cannot answer says so.** `outcomeFor()` resolving to
`undefined` — an unknown token, an unreachable emulator, a malformed body —
degrades to `actual: "unknown"`. It never degrades to `committed`.

Every outcome records where `actual` came from:

```text
oracle    a privileged backend was asked and answered
declared  the injected fault defines it, because CloudFault chose the moment
          of failure itself (it cut the wire after a call that had returned)
inferred  deduced from an observable proxy such as a 2xx status
unknown   nothing established it
```

`inferred` is where the old behaviour lives, now labelled rather than hidden: a
200 implies durability for some backends and not for others (Slack and Shopify
report application errors with HTTP 200), and a 500 does not imply the write
did not land. An oracle overrules both.

Two implementations ship: `RecordingOutcomeOracle` for in-process backends, and
`httpOutcomeOracle()` (`@gmacko/cloudfault/adapter-sdk/emulate`) for an emulator
serving `GET /_cloudfault/outcome/:token`, `/version/:resource`, `/snapshot` and
`POST /_cloudfault/reset`. `postFaultPlan()` drives the matching control plane,
and surfaces the emulator's contract-probe refusal rather than swallowing it.

## Operation identity

Faults cannot be addressed as "the third fetch" if CloudFault expects repeatable exploration. `ScenarioController` and `ExecutionIndexer` assign a context-relative identity using logical target, operation, resource, parent operation, callsite, and occurrence.

Selectors can target:

```text
target
operation
resource
process
callsite
executionIndex
occurrence
maxActivations
statementIndex
```

`statementIndex` addresses one statement inside a multi-statement operation
(the Nth statement of a `D1Database.batch()`). An operation that is not itself a
sub-operation carries no `statementIndex` and is therefore not filtered by it,
so a batch executor can discover a statement-scoped fault and apply it at the
right index.

This is the first step toward full Distributed Execution Indexing-style dynamic call identity.

## Exploration and minimization

`exploreScenarios()`:

1. executes a fault-free baseline;
2. enumerates one choice from each selected fault point;
3. explores depth 1 through bounded depth N;
4. stops on the first failure by default; and
5. delta-reduces that failure to a **1-minimal failure set**.

The current minimizer guarantees 1-minimality: no single remaining perturbation can be removed without losing the failure. It does not claim globally minimum cardinality.

Workload/data shrinking is a distinct concern and is delegated toward fast-check rather than conflated with fault-set minimization.

## D1 `batch()` and contract probes

`createD1FaultProxy()` interposes on `prepare().bind().first/all/run/raw` **and
on `batch()`**. The batch seam is the one that matters for application
correctness: `@effect/sql-d1`, Drizzle, and hand-rolled guarded writes all
express their unit of work as one `batch()`, so a proxy that only reached the
single-statement path could not reach an application's most valuable
invariants at all.

Real D1 `batch()` is atomic. Three of the batch faults model behaviour D1 can
genuinely produce:

```text
d1BatchRejectBeforeCommit       nothing applied,  definite failure
d1BatchCommitThenResponseLost   all applied,      indeterminate
d1BatchErrorAfterCommit         all applied,      definite failure (and wrong)
```

The fourth, `d1PartialBatchApplication`, does not. It is a **contract probe**: a
legal-elsewhere behaviour used to discover whether an application silently
depends on atomicity. CloudFault refuses to run it unless the proxy is
constructed with `allowContractProbes: true`, mirroring the emulate Cloudflare
emulator, which refuses the same kinds unless a plan opts in. `D1_CONTRACT_PROBE_KINDS`
names them. Presenting a probe as D1 behaviour would be exactly the
overclaiming the roadmap's release bar forbids.

On the probe path CloudFault bypasses the native `batch()` (there is no other
way to apply a prefix of an atomic call), runs the prefix statement by
statement, and emits one child operation per statement carrying
`statementIndex`, so the resulting history says exactly which statements landed.

## Multi-event workloads

A delivery fault needs something to be delivered *against*. `webhook-reorder`
and `webhook-delay` say nothing about a workload that emits one event: there is
nothing to be out of order with, and nothing for a delay to arrive after.

`runEventWorkload()` emits several related events and delivers them under the
scenario's `delivery`-phase perturbations:

```ts
const { plan, results } = await runEventWorkload({
  controller,
  target: "WEBHOOKS",
  events: [
    { id: "evt_1", type: "order.created", payload },
    { id: "evt_2", type: "order.paid", payload },
    { id: "evt_3", type: "order.fulfilled", payload },
  ],
  deliver: ({ delivery }) => handler(delivery.event),   // -> { applied: boolean }
});
```

Each event gets an `event.emit` operation, so a delivery fault can be addressed
to one event by `selector.resource` and is activated through the controller —
which keeps it visible to the activation log, the MFS reducer and the causal
report. Each delivery attempt is a child operation of its event, so duplicates
and reorderings appear as lineage rather than loose history noise.
`eventDelay()`, `eventDuplicate()` and `eventReorder()` in the adapter SDK build
the scoped faults.

**Order is derived, not asserted.** Delivery order comes out of arrival time, so
delaying one event of three genuinely lands it after the other two — which is
how reordering happens in practice rather than being a separate flag.

Three checkers read the resulting history:

```text
checkDeliveryOrder          were events APPLIED in creation order?
checkDeliveryUniqueness     was any event APPLIED more than once?
checkDeliveryCompleteness   was every event applied at least once?
```

The distinction they all turn on is delivery versus application. Duplicate
*delivery* is contract behaviour — at-least-once is what these providers
promise. Duplicate *application* is the bug. A handler reports which by
returning `{ applied: false }` for a duplicate it recognised, so an idempotent
handler and a naive one produce identical delivery traces and different verdicts.

The workload stays a plain array, so `shrinkSequence()` and
`shrinkCounterexample()` still delta-debug it: a six-event workload with one
delayed event reduces to the delayed event plus one it can overtake.

## Interleaving exploration

`runConcurrentWorkload()` records the schedule that happened.
`exploreInterleavings()` enumerates schedules instead: actors declare their own
suspension points with `await context.yield()`, every ordering of those points
is replayed deterministically, and a failing schedule is a plain array of actor
names that re-runs as-is.

```ts
const exploration = await exploreInterleavings({
  setup: () => ({ state, actors }),
  check: ({ state, results }) => exactlyOneWinner(state, results),
});
```

A schedule is a `SemanticVariation`, not a `Fault`: nothing failed, the
application is simply wrong under a legal ordering.

This is a **bounded** model, not a sound one — only declared suspension points,
no partial-order reduction, a hard `maxSchedules` cap that reports when it bit,
and one isolate. [docs/concurrency.md](concurrency.md) states the limits and why
CloudFault stops short of a model checker.

## Runtime paths

### Wrangler Test Harness

`createCloudFaultHarness()` dynamically uses Wrangler's `createTestHarness()`. The application Worker is built normally. `bindingOverrides` route selected bindings through auxiliary test Workers.

CloudFault's generated/test Nemesis Workers expose control over JSRPC:

- service plan: reject, 429/5xx, latency, commit-then-response-loss;
- KV observer/version history: stale positive and stale negative reads;
- Queue producer: pass, fail, duplicate logical enqueue record.

`applyScenarioToNemesisBindings()` translates the same CloudFault perturbation objects used by the search engine into this control plane.

### Outbound APIs via MSW

`AdapterRuntime` classifies a real outbound `Request`, creates a logical operation, activates semantic provider faults, and delegates happy-path behavior to either:

- an in-memory backend;
- a local emulator;
- a provider sandbox; or
- the real upstream request via MSW bypass.

This is how CloudFault can represent `commitThenTimeout`: call the stateful backend first, record its commit, then make the Worker observe a network failure.

### Direct Miniflare

The high-level harness is preferred for application integration tests. Direct Miniflare is the escape hatch for simulator operations such as explicit Queue and Scheduled dispatch. `dispatchQueueScenario()` and `dispatchScheduledScenario()` translate legal delivery/execution variations into actual low-level dispatch calls.

## Binding-shape constraint

A test Worker is a useful replacement only when its RPC surface is compatible with the application's binding usage. KV methods are asynchronous and map well to a JSRPC shim. Queue producer methods are also promise-shaped in application usage.

D1 is different: `prepare()` returns a statement builder synchronously and chained methods such as `bind()` are part of that object surface. CloudFault therefore does not claim that a Service Binding override transparently replaces D1. D1 semantics are currently modeled separately while real D1 operations use the local binding. A future D1 injection layer must preserve the binding API rather than pretending JSRPC is equivalent.

## Adapter ecosystem

The SDK has two authoring levels:

- `defineRulesAdapter()` for host/path/method semantic classifiers with a standard fault catalog;
- `defineAdapter()` for full provider-specific logic.

Adapters can be distributed as plugins via `defineAdapterPlugin()` and loaded into `AdapterRegistry`. Provider implementation and provider failure semantics are intentionally decoupled: an adapter is useful without implementing every endpoint.

## Artifacts

A CloudFault failure artifact contains:

- schema/version;
- test name and seed;
- exact failing scenario;
- Minimal Failure Set;
- logical history;
- checker failures;
- optional final state;
- replay descriptor; and
- environment/metadata.

The CLI can render or replay these artifacts without relying on terminal output from the original run.
