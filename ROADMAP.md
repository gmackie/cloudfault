# CloudFault Roadmap

## V0 — semantic core

- Jepsen-style operation history (`invoke`, `ok`, `fail`, `info`).
- Separate actual provider outcome from caller observation.
- Systematic bounded fault-set exploration.
- Minimal Failure Set reduction.
- Seeded randomness for reproducible scenarios.
- Public semantic adapter API and adapter registry.
- Cloudflare KV eventual-consistency observer model.
- Queue duplicate delivery and rebatching model.
- D1 transient failure model.
- R2 transient capacity failure model.
- Service-binding failure model.
- Stripe semantic adapter.
- Optional fast-check bridge.
- Wrangler topology inspection.

## V0.1 — real Worker execution

- Drive Workers using Cloudflare `createTestHarness()`.
- Add auxiliary Nemesis Workers through `bindingOverrides`.
- Add outbound API interception through `@msw/cloudflare`.
- Build checkout fixture using KV + D1 + Queue + Stripe.
- Capture all interactions in the CloudFault history.
- Replay a captured failing scenario.

## V0.2 — execution indexing

Implement a Workers/JavaScript adaptation of Distributed Execution Indexing so logical dependency calls can be identified across reruns despite:

- loops,
- concurrency,
- changing schedules,
- repeated endpoints,
- multiple resources using the same provider operation.

Identity should incorporate logical parent operation, provider adapter, semantic operation, resource identity, ancestry, callsite metadata, and context-local ordinal.

## V0.3 — systematic search

- baseline interaction discovery,
- depth-1 semantic/fault exploration,
- bounded depth-N combination search,
- result caching,
- redundancy elimination,
- Minimal Failure Set diagnosis,
- semantic variation × provider degradation × workload ordering.

Study Filibuster, LDFI, and FaultWeave rather than inventing search algorithms from scratch.

## V0.4 — invariants and convergence

- synchronous invariant checker,
- state-machine checker,
- eventually/convergence checker,
- idempotency checker,
- assertion points inside asynchronous flows,
- application-defined privileged state inspection.

## V1 — Cloudflare semantic packs

- KV propagation and cached-negative views,
- Queues at-least-once delivery and batch variation,
- Durable Object alarms/retries/resets,
- D1 transient backend failures and replica semantics,
- R2 failures and object-state transitions,
- Workflows retries,
- Cache API,
- service bindings and RPC.

Expose at least two test profiles:

- `cloudflare-contract`: behavior allowed by documented platform semantics.
- `cloudflare-degraded`: plausible platform/backend degradation.

## V1 — external adapters

First-party-maintained but unofficial semantic adapters, prioritizing integrations with interesting failure behavior:

Stripe, GitHub, OpenAI, Anthropic, Slack, Google APIs, Microsoft Graph, AWS, Twilio, SendGrid, Resend, PayPal, Shopify, Clerk, Auth0, WorkOS, Okta, Supabase, Firebase, MongoDB Atlas, Vercel, Linear, Discord, Cloudinary, Algolia.

Adapters must remain public and independently implementable from day one.

## V2 — provider backends

Support adapters backed by:

- synthetic responses,
- stateful local emulators,
- `emulate` service packages,
- real provider sandbox/test environments through a proxy.

## V2 — generated workloads

- deeper fast-check integration,
- state-machine commands,
- workload shrinking,
- async schedule exploration,
- separate workload minimization from Minimal Failure Set reduction.

## V3 — incident composition

Move beyond independent fault probabilities:

- correlated storage degradation,
- provider rate limiting,
- retry storms,
- latency incidents,
- multiple simultaneous provider failures,
- virtual Cloudflare observers/regions.

## V4 — automatic analysis

Inspect Wrangler configuration, dependency imports, fetch callsites, SDK use, queue consumers, and durable state transitions to recommend:

- relevant semantic adapters,
- likely ambiguity boundaries,
- risky retry patterns,
- likely application invariants,
- targeted fault combinations.

The agent should reason from executable platform/provider semantics rather than invent generic edge cases.
