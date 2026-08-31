# Roadmap

## V0 — core model

- [x] Jepsen-style logical history with indeterminate (`info`) outcomes.
- [x] Actual-outcome vs caller-observed-outcome metadata.
- [x] Separate legal semantic variations from degradation faults.
- [x] Context-relative operation occurrence / execution indexing.
- [x] Systematic bounded perturbation-combination enumeration.
- [x] 1-minimal failure-set reduction.
- [x] Failure artifact schema, reporter, timeline, and replay descriptor.
- [x] Concurrent logical workload helper.
- [x] Optional fast-check bridge.

## V0.1 — real Worker vertical slices

- [x] Wrangler `createTestHarness()` wrapper.
- [x] Auxiliary JSRPC Nemesis Worker templates for service, KV, and Queue producer bindings.
- [x] Scenario -> Nemesis Worker control-plane translation.
- [x] MSW outbound semantic adapter runtime.
- [x] Checkout Worker fixture using KV + D1 + Queue + payment Service Binding.
- [x] Outbound Stripe Worker fixture using ordinary `fetch()` + MSW.
- [x] Stateful Stripe backend for commit/outcome ambiguity.
- [x] CLI `run`, `replay`, `timeline`, `inspect`, `adapters`, `init`, and `demo`.
- [ ] Keep the workerd integration suite green against current Wrangler in CI.

## V0.2 — Cloudflare contract pack

- [x] KV stale positive/negative observer histories and version-lag model.
- [x] Binding-compatible KV Nemesis Worker with observer/lag controls.
- [x] Queue duplicate/rebatch semantics.
- [x] Direct Miniflare Queue scenario dispatch.
- [x] Scheduled duplicate/delay semantics and direct Miniflare dispatch.
- [x] D1 transient error primitives and read-replica/session model.
- [x] R2 transient/capacity failure primitives.
- [x] Service Binding timeout/unavailability primitives.
- [x] Durable Object alarm retry/reset semantic primitives.
- [x] Workflow retry semantic primitives.
- [ ] Queue consumer retry/ack/DLQ end-to-end fixtures.
- [ ] Durable Object alarm end-to-end fixture.
- [ ] Workflow retry end-to-end fixture.
- [ ] D1 low-level fault injection that preserves the native statement-builder API.
- [ ] R2 end-to-end degradation shim.

## V0.3 — systematic search

- [x] Baseline-first execution.
- [x] Depth-1 through bounded depth-N exploration.
- [x] Distributed Execution Indexing-inspired operation identity.
- [x] Fault-set MFS minimization separate from workload shrinking.
- [ ] Baseline dependency-call discovery that proposes fault points automatically.
- [ ] Successful-history pruning / LDFI-style search reduction.
- [ ] Pairwise/covering-array strategy for large fault spaces before full depth-N.
- [ ] Correlated incident profiles and retry-storm scenarios.
- [ ] Persist scenario cache/results to avoid repeating known-equivalent executions.
- [ ] Deeper fast-check model/command integration and shrunk workload witnesses.

## V0.4 — adapter ecosystem

- [x] Generic provider-neutral HTTP semantic runtime.
- [x] Declarative rules adapter builder.
- [x] Public plugin contract and dynamic plugin loading.
- [x] Bundled unofficial catalog of 25 provider adapters.
- [x] Source import/API-host detector.
- [x] Stripe stateful backend.
- [ ] Adapter conformance-test kit.
- [ ] Explicit adapter maturity metadata (classifier / semantic / stateful / conformance).
- [ ] Shared webhook delivery model (delay, duplicate, reorder, signature).
- [ ] Shared streaming interruption model.
- [ ] Shared OAuth/token-expiry model.
- [ ] Shared asynchronous-job lifecycle model.
- [ ] `emulate` bridge for compatible stateful provider implementations.
- [ ] Provider-specific signed webhook fixtures for the highest-value adapters.

## V0.5 — developer experience

- [x] Wrangler topology discovery.
- [x] Known SDK/API usage discovery from source.
- [ ] `cloudfault init` generates suggested fault points from discovered topology.
- [ ] `cloudfault doctor` validates runtime dependencies and adapter coverage.
- [ ] GitHub Actions annotations / machine-readable reporter.
- [ ] HTML history/timeline artifact.
- [ ] Scenario coverage report: discovered calls vs exercised perturbations.
- [ ] Agent-assisted invariant and scenario recommendations.

## V1

- [ ] Simulated region/observer profiles for multi-location consistency testing.
- [ ] Staging/remote execution backend using the same Scenario/History/Checker model.
- [ ] Traffic-import bridge for captured production-shaped workloads.
- [ ] Provider semantics registry with versioned contract evidence.
- [ ] Coverage-guided/autoresearch-style search over perturbation + workload space.
