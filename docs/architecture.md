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
```

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
