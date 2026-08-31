# CloudFault

CloudFault is systematic resilience and distributed-correctness testing for Cloudflare Workers applications.

It combines ideas from Jepsen, Filibuster, lineage-driven fault injection, FaultWeave, Cast, and property-based testing with the Cloudflare Workers test runtime.

The goal is not to make Workers randomly fail. The goal is to prove that an application preserves its business invariants when cloud primitives and external APIs behave according to their real distributed semantics — including eventual consistency, retries, duplicate delivery, transient backend failures, and ambiguous external side effects.

## Why CloudFault?

A Worker can be perfectly correct on the happy path and still fail under a legal sequence like:

```text
KV returns a stale order state
        +
Stripe commits a payment but the response times out
        +
the application retries
        =
duplicate charge
```

CloudFault models those conditions as semantic events, records a Jepsen-style history, systematically explores bounded fault combinations, checks application invariants, and reduces failures to a Minimal Failure Set.

## V0 packages

- `@cloudfault/core` — histories, checkers, seeded randomness, bounded fault-set exploration, and Minimal Failure Set reduction.
- `@cloudfault/adapter-sdk` — public provider/plugin interface and reusable semantic fault primitives.
- `@cloudfault/cloudflare` — Cloudflare-specific semantic models for KV, Queues, D1, R2, service bindings, plus a thin `createTestHarness()` bridge.
- `@cloudfault/stripe` — first unofficial external provider semantics adapter.
- `@cloudfault/fast-check` — optional integration with fast-check for generated workloads and shrinking.
- `cloudfault` CLI — topology inspection and a runnable semantic-failure demo.

## Quick start

```bash
npm install
npm run build
npm test
```

Run the demonstration scenario:

```bash
npm run demo
```

Inspect a Wrangler topology:

```bash
node packages/cli/bin/cloudfault.mjs inspect examples/checkout/wrangler.jsonc
```

## History semantics

CloudFault borrows Jepsen's core outcome vocabulary:

- `invoke` — operation began.
- `ok` — operation definitely succeeded.
- `fail` — operation definitely failed.
- `info` — the caller cannot know whether the operation succeeded.

The final category is critical for external side effects. If Stripe commits a charge and the connection disappears before the response reaches the Worker, the application observes an indeterminate result even though the provider committed the mutation.

CloudFault therefore keeps actual provider outcome separate from caller observation whenever the test backend knows both.

## Semantic variation vs provider degradation

CloudFault deliberately separates legal distributed semantics from failures.

Legal semantics include:

- stale KV observer views,
- delayed propagation,
- cached negative lookups,
- duplicate Queue delivery,
- Queue rebatching.

Provider degradation includes:

- D1 transient network failures,
- D1 storage resets,
- unavailable replicas,
- D1 operation timeouts,
- R2 transient capacity failures,
- service-binding timeouts and 503s.

A stale read is not Cloudflare breaking. It is the application being forced to operate under the consistency model it selected.

## Example

The V0 demo models checkout with two semantic conditions:

1. a remote KV observer sees the previous order version;
2. a Stripe confirmation commits but its response times out.

Each condition independently preserves the `at-most-one-charge` invariant. Combined, they cause a duplicate charge. CloudFault searches the bounded fault space and reduces the failure to exactly those two conditions.

```text
Baseline: PASS
Combined scenario: FAIL

Minimal Failure Set:
  - stale-read
  - commit-then-timeout
```

That is the core thesis of the project: the interesting resilience bugs often live in combinations rather than single injected errors.

## Architecture

```text
                    workload
                       │
                       ▼
             CloudFault controller
             ├─ systematic search
             ├─ generated workloads
             └─ history recorder
                       │
                       ▼
           Cloudflare createTestHarness
                       │
                    workerd
                       │
               application Worker
                 │             │
                 ▼             ▼
        Cloudflare bindings   external APIs
                 │             │
                 ▼             ▼
          semantic models   adapters
                 │             │
                 └──────┬──────┘
                        ▼
                     history
                        │
                        ▼
                  invariant checks
                        │
                        ▼
                Minimal Failure Set
```

See `docs/architecture.md` for the intended architecture and `ROADMAP.md` for planned development.

## Provider adapters

Adapters describe *meaning*, not merely URLs.

For example a Stripe adapter can identify `payment.confirm` as:

- externally visible,
- mutating,
- potentially indeterminate,
- safely retryable only when the appropriate idempotency mechanism is used.

A generic HTTP proxy can inject a timeout. A semantic Stripe adapter can inject `commitThenTimeout()` and know that the payment actually exists while the caller believes the result is unknown.

See `docs/adapter-authoring.md`.

## Status

CloudFault is an experimental V0. The current code establishes the semantic model and search architecture. The next milestone is executing the same scenarios through real Workers under Cloudflare's test harness using auxiliary Nemesis Workers and outbound HTTP interception.

## License

MIT
