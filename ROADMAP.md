# CloudFault roadmap

This file tracks the **remaining** work. Earlier V0 checklists became stale as the implementation moved quickly; completed capabilities are summarized first so TODOs are not mistaken for missing code.

## Implemented foundation

### Correctness model

- [x] Jepsen-style `invoke` / `ok` / `fail` / `info` history.
- [x] Actual provider outcome separated from caller-observed outcome.
- [x] Operation lineage, parent/child relationships, retry identity, and context-relative execution indexes.
- [x] Legal semantic variation separated from degradation faults.
- [x] Causal graph + failure-witness extraction.
- [x] Unified incident model containing checks, MFS, history, and causal witness.

### Oracles

- [x] Context-aware invariants.
- [x] State-only invariant templates.
- [x] State-machine legality checking.
- [x] Cardinality/idempotency checks.
- [x] `eventually()` convergence polling.
- [x] implication, orphan, conservation, monotonicity, and uniqueness templates.
- [x] observer consistency legality, monotonic reads, read-your-writes, sequential-session, and divergence checks.

### Search + minimization

- [x] depth-bounded exhaustive search.
- [x] pairwise/covering-array search.
- [x] feedback-guided search.
- [x] coverage-guided search prioritizing unseen perturbations and pairs.
- [x] correlated incident profiles and retry-storm composition.
- [x] hybrid planner.
- [x] baseline dependency-call discovery.
- [x] lineage-driven incremental fault-space discovery.
- [x] persistent scenario/result cache.
- [x] 1-minimal failure-set reduction.
- [x] fast-check scenario generation/shrinking.
- [x] independent workload delta-debugging.
- [x] alternating fault-set + workload counterexample shrinking.

### Cloudflare semantics/runtime

- [x] Wrangler `createTestHarness()` bridge.
- [x] service-binding Nemesis Worker boundaries with private control routes.
- [x] MSW semantic provider interception.
- [x] direct Miniflare Queue + Scheduled dispatch.
- [x] KV observer histories, stale positive/negative reads, and version lag.
- [x] Queue duplicate/rebatch/retry/DLQ lifecycle.
- [x] D1 transient faults, replica/session model, and shape-preserving fault proxy.
- [x] R2 degradation and shape-preserving fault proxy.
- [x] Service Binding timeout/unavailability semantics.
- [x] Durable Object alarm/reset/retry semantics and runtime fixtures.
- [x] Workflow step retry/delay semantics and runtime fixtures.
- [x] Scheduled duplicate/delay semantics.
- [x] logical observer-region profiles.
- [x] workerd/Vitest/Miniflare integration suite in CI.

### Provider ecosystem

- [x] public `SemanticAdapter`/plugin contract.
- [x] declarative rules adapter builder.
- [x] 25 bundled unofficial provider adapters.
- [x] generic semantic HTTP runtime.
- [x] capability-aware executable semantic overlays.
- [x] provider-specific behaviors for high-value cases such as Anthropic overload, GitHub secondary limits, Slack HTTP-200 errors, and Shopify GraphQL HTTP-200 errors.
- [x] shared webhook delivery model.
- [x] shared streaming interruption model.
- [x] shared OAuth/token lifecycle model.
- [x] shared async-job model.
- [x] shared token-bucket/rate-limit model.
- [x] stateful Stripe backend.
- [x] `emulate` backend bridge.
- [x] adapter conformance runner + maturity levels.
- [x] versioned semantic contract snapshots and breaking-change detection.
- [x] portable Stripe/GitHub/Slack/Shopify webhook signers plus Node-side signed webhook fixtures/verifiers.
- [x] source SDK/API-host detection.
- [x] semantics-grounded recommendations.

### Execution/reporting/developer experience

- [x] local function backend.
- [x] remote HTTP backend.
- [x] versioned remote execution-agent protocol + capability query.
- [x] HAR traffic import / replay corpus.
- [x] replayable failure artifacts.
- [x] text timeline.
- [x] JSON report.
- [x] JUnit report.
- [x] GitHub Actions annotations.
- [x] HTML report with MFS, dependency coverage, indeterminate outcomes, and causal chain.
- [x] Wrangler/source project discovery.
- [x] project-aware `cloudfault init`.
- [x] `cloudfault doctor`.
- [x] `cloudfault inspect`, `recommend`, `plan`, `run`, `replay`, `timeline`, and `adapters`.
- [x] CLI semantic registry and semantic-contract export.

## V0.6 — hardening and evidence

- [ ] Expand semantic-contract fixtures from the initial high-value provider subset to all 25 bundled adapters.
- [ ] Promote additional adapters from `semantic` to `conformant` only after provider-specific behavioral/runtime tests exist.
- [ ] Add contract-evidence URLs/version identifiers that are refreshed by a maintenance workflow without silently changing behavior.
- [ ] Add signed inbound webhook Worker fixtures for Stripe, GitHub, Slack, Shopify, Twilio, Resend, and Svix-compatible providers.
- [ ] Add more provider-specific response-body failure modes where HTTP status alone is misleading.
- [ ] Split broad AWS/Google provider adapters into service-specific semantic modules where service contracts differ materially.
- [ ] Remove or deprecate inaccurate legacy capability labels in the raw catalog as the evidence registry supersedes them.

## V0.7 — search quality

- [ ] Persist `CoverageGuidance` snapshots across independent CI runs, not only prior run results.
- [ ] Feed causal-witness novelty back into search scoring.
- [ ] Add successful-history pruning using explicit dependency/lineage equivalence rather than scenario ID alone.
- [ ] Add adaptive exploration that can discover new lineage fault points and coverage-guide the same live search session.
- [ ] Add workload-model command shrinking that preserves preconditions, beyond generic sequence delta-debugging.
- [ ] Add configurable search budgets by runtime cost, not only scenario count/depth.
- [ ] Add parallel execution for independent scenarios while keeping one scenario deterministic/replayable.

## V0.8 — consistency + runtime fidelity

- [ ] Multi-observer workload runner that automatically merges per-observer histories into one causal history.
- [ ] Explicit session/bookmark adapters for D1 read-replica workloads.
- [ ] Cache API semantic pack and runtime fixture.
- [ ] Hyperdrive/Postgres failure pack.
- [ ] Vectorize semantic/failure pack.
- [ ] Workers AI streaming/usage semantic pack.
- [ ] Browser Rendering/API-specific integration pack where useful.
- [ ] More precise CPU/subrequest/deadline budget simulation with clear labels distinguishing synthetic enforcement from workerd enforcement.

## V0.9 — remote/staging

- [ ] Reference deployable Worker implementation of the remote-agent protocol.
- [ ] Signed request authentication and replay protection for remote agents.
- [ ] Capability negotiation that refuses scenarios requiring unsupported bindings/faults.
- [ ] Staging proxy mode for provider sandboxes with secret-safe redaction.
- [ ] Remote result streaming for long systematic runs.
- [ ] Remote artifact upload/download and stable run IDs.

## V1 — ecosystem + research loop

- [ ] Public adapter manifest/registry discovery independent of the bundled package.
- [ ] Adapter compatibility matrix against CloudFault semantic-contract schema versions.
- [ ] Record/replay import beyond HAR (OTel spans and structured application traces).
- [ ] Source/call-graph analysis that proposes business invariant templates from side-effect boundaries.
- [ ] Agent loop that reasons from provider/Cloudflare evidence, histories, and existing failures rather than generating generic edge cases.
- [ ] Autoresearch/optimizer interface that can tune workload distributions and search objectives while CloudFault remains the deterministic evaluator.
- [ ] Historical regression corpus: every discovered production/CI failure can become a pinned minimized scenario.

## Release bar for `1.0`

CloudFault should not call itself 1.0 until:

1. the normal CLI workflow can initialize, plan, run, minimize, replay, and report without custom glue for common Worker projects;
2. the core Cloudflare semantic packs have real runtime fixtures and documented limitations;
3. provider semantics are evidence/version tracked and do not overclaim emulator completeness;
4. the remote-agent protocol is authenticated and version-negotiated;
5. search remains bounded/reproducible and produces useful minimized witnesses under CI load; and
6. current Wrangler/workerd compatibility is continuously exercised.
