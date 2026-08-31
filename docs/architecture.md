# Architecture

CloudFault is a systematic resilience and distributed-correctness test framework for applications running on Cloudflare Workers.

## Design principles

### Histories before faults

Every execution produces an immutable logical history. Fault injection is valuable because of what it causes in that history, not because a dependency returned an error.

### Semantic operations before URLs

Adapters classify calls into logical operations such as `payment.confirm` or `message.send`. This lets CloudFault reason about idempotency, externally visible side effects, and indeterminate outcomes rather than treating every integration as generic HTTP.

### Legal semantics are not faults

Eventual consistency, stale reads, duplicate queue delivery, and rebatching can be allowed behavior. CloudFault models these separately from provider degradation such as timeouts, transient 5xx responses, or backend resets.

### Systematic search before random chaos

Random fault probabilities remain useful for soak testing, but correctness mode should enumerate bounded semantic/fault combinations and reduce failures to a Minimal Failure Set.

### Reuse the ecosystem

CloudFault should not implement a runtime, HTTP proxy, provider emulator, or property-testing engine if a high-quality component already exists.

Expected building blocks include:

- Cloudflare `createTestHarness()` / workerd,
- Miniflare only as a lower-level escape hatch,
- `@msw/cloudflare` for HTTP interception,
- stateful provider emulators such as `emulate`,
- fast-check for property/model generation and workload shrinking,
- optional transport proxies for lower-level TCP failure behavior.

## Core packages

### `@cloudfault/core`

Owns:

- history representation,
- logical operation and fault types,
- check results,
- bounded combination exploration,
- Minimal Failure Set reduction,
- deterministic scenario seeding.

It deliberately knows nothing about Cloudflare.

### `@cloudfault/adapter-sdk`

Defines the stable public provider integration surface.

An adapter maps concrete requests to logical operations and contributes semantic fault templates, state/consistency metadata, and optional recommended invariants.

### `@cloudfault/cloudflare`

Contains executable models of Cloudflare platform semantics and degradation conditions.

The V0 implementation contains a region/observer-aware KV model, Queue delivery transformations, D1 transient errors, R2 transient capacity errors, service-binding faults, and a lazy harness bridge.

### `@cloudfault/stripe`

The first provider semantics adapter. It demonstrates mutating external side effects, idempotency-key support, and ambiguous payment confirmation outcomes.

### `@cloudfault/fast-check`

Optional bridge into fast-check without making property testing a hard dependency of core.

## Search model

A discovered scenario contains a set of candidate semantic variations and faults.

CloudFault initially explores subsets in ascending cardinality:

```text
∅
A
B
C
A+B
A+C
B+C
A+B+C
```

When a failing set is discovered, CloudFault removes elements while preserving failure to derive a 1-minimal failure set.

Future search should incorporate ideas from lineage-driven fault injection, Filibuster, and FaultWeave to avoid combinatorial explosion.

## Outcome model

Each operation can distinguish system reality from caller observation.

```text
actualOutcome      observedOutcome
-------------      ---------------
committed          success
not-committed      failure
committed          indeterminate
unknown            indeterminate
```

An indeterminate operation is recorded as a history `info` event.

This distinction is fundamental for integrations where an irreversible side effect may have occurred before transport failure prevents the caller from observing the result.
