# CloudFault

**Jepsen-lite for Cloudflare Workers.**

CloudFault systematically tests whether a Worker application remains logically correct when Cloudflare primitives, external APIs, retries, concurrency, stale observations, duplicate delivery, backend degradation, and ambiguous side effects interact.

It is not a random “make 5% of requests fail” chaos library. CloudFault builds logical histories, explores bounded and coverage-guided perturbation combinations, checks business invariants, and reduces failures into two independent witnesses:

1. the **Minimal Failure Set** — the smallest set of perturbations required to reproduce the bug; and
2. the **minimal workload** — the smallest client/event sequence that still exposes it.

```text
legal stale observer state
        +
payment provider commits -> response lost
        +
application retry
        =
duplicate financial effect
```

The outcome model is deliberately three-valued:

```text
SUCCESS | DEFINITE FAILURE | INDETERMINATE
```

An indeterminate operation becomes a Jepsen-style `info` completion. When a stateful emulator/test backend has privileged knowledge, CloudFault records the provider’s actual outcome separately from what the application observed.

## Current status

CloudFault is an experimental but executable framework. The repository currently includes:

- Jepsen-style `invoke` / `ok` / `fail` / `info` histories;
- parent/child operation lineage and context-relative execution indexing;
- systematic depth-N, pairwise, feedback-guided, **coverage-guided**, incident, and hybrid search;
- lineage-driven fault-space discovery from calls actually reached by executions;
- persistent scenario-result caching;
- 1-minimal fault-set reduction;
- independent workload delta-debugging and combined counterexample shrinking;
- synchronous invariants, state-machine checking, cardinality/idempotency checks, convergence polling, conservation, uniqueness, monotonicity, implication, and orphan detection;
- causal failure graphs and witness extraction;
- JSON, JUnit, GitHub Actions, text timeline, and HTML reports;
- portable local/remote execution backends and a versioned remote-agent protocol;
- Cloudflare KV, D1, R2, Queue, Durable Object, Workflow, Scheduled, Service Binding, and observer-region semantics;
- shape-preserving D1 and R2 degradation proxies, including committed-write/lost-response ambiguity;
- direct Miniflare Queue/Scheduled lifecycle control including retries and DLQ transitions;
- real workerd/Vitest/Miniflare integration fixtures;
- a public semantic provider adapter/plugin SDK;
- adapter conformance/maturity checks and versioned semantic-contract snapshots;
- stateful Stripe ambiguity testing;
- shared webhook, OAuth, streaming, async-job, and rate-limit capability models;
- provider-shaped signed webhook helpers;
- **25 bundled unofficial provider adapters** with capability-aware semantic overlays; and
- project discovery, `init`, `doctor`, planning, recommendations, semantic registry output, replay, and reporting from the CLI.

Bundled adapters model a useful semantic subset. They do **not** claim to be complete provider emulators. An adapter can use synthetic responses, proxy a real sandbox/test API, sit over a stateful emulator such as `emulate`, or use a purpose-built backend such as the included Stripe fixture.

## Install

CloudFault ships as a single package on npm:

```bash
npm install --save-dev @gmacko/cloudfault
```

```ts
import { defineCloudFault } from "@gmacko/cloudfault";                 // core
import { staleKvRead } from "@gmacko/cloudfault/cloudflare";
import { stripeAdapter } from "@gmacko/cloudfault/stripe";
import { defineRulesAdapter } from "@gmacko/cloudfault/adapter-sdk";
import { firstPartyAdapters } from "@gmacko/cloudfault/adapters";
import { findScenarioCounterexample } from "@gmacko/cloudfault/fast-check";
```

## Repository layout

This is an npm workspace. Only `packages/cloudfault` (`@gmacko/cloudfault`) is
published; the `@cloudfault/*` packages below are private and are folded into
its `dist/` at build time by `scripts/build-package.mjs`, which rewrites their
cross-package specifiers to relative paths.

```text
packages/cloudfault      @gmacko/cloudfault — THE published package
packages/core            history, lineage, search, MFS, oracles, diagnostics, reports, backends   -> "."
packages/adapter-sdk     semantic adapter API, capability packs, conformance, contracts, signers  -> "./adapter-sdk"
packages/cloudflare      Cloudflare semantics and workerd/Miniflare/MSW runtime bridges           -> "./cloudflare"
packages/stripe          Stripe semantic adapter + stateful in-memory payment backend             -> "./stripe"
packages/adapters        bundled unofficial provider catalog + executable semantic overlays       -> "./adapters"
packages/fast-check      property-testing bridge + workload/counterexample shrinking              -> "./fast-check"
packages/cli             developer CLI                                                            -> the `cloudfault` bin
```

Repo-internal code (tests, examples) imports the workspace names directly.
Anything a consumer sees — the README, `docs/`, and the config that
`cloudfault init` generates — uses the published `@gmacko/cloudfault` names.

## Development

```bash
npm install
npm test              # build + unit + workerd integration + Workers Vitest
npm run build         # tsc -b, then assemble packages/cloudfault/dist
npm run pack          # build + npm pack the publishable package
npm run sync-versions # propagate packages/cloudfault's version everywhere
```

The CI suite intentionally includes real runtime fixtures against the currently pinned Wrangler/workerd stack so Cloudflare testing-runtime drift is caught rather than hidden behind unit mocks.

## CLI

```bash
# inspect bindings + provider usage and recommend correctness tests
npm run cloudfault -- inspect ./wrangler.jsonc ./src

# generate a project-aware starter config
npm run cloudfault -- init

# verify dependencies, topology, and semantic coverage
npm run cloudfault -- doctor

# print a scenario plan without executing it
npm run cloudfault -- plan ./cloudfault.config.mjs

# execute the configured systematic search
npm run cloudfault -- run ./cloudfault.config.mjs

# replay a minimized failure
npm run cloudfault -- replay .cloudfault/failures/<failure>.json

# render a saved history
npm run cloudfault -- timeline .cloudfault/failures/<failure>.json

# inspect bundled provider support
npm run cloudfault -- adapters
npm run cloudfault -- lifecycle stripe

# emit versioned executable semantics artifacts
npm run cloudfault -- semantics .cloudfault/provider-semantics.json
npm run cloudfault -- contracts .cloudfault/semantic-contracts.json
npm run cloudfault -- contract shopify
```

## Search strategies

A normal config can choose:

```js
export default {
  strategy: "coverage-guided", // exhaustive | pairwise | guided | coverage-guided | incidents | hybrid
  maxDepth: 3,
  maxScenarios: 250,
  previousRuns,
  faultPoints,
  execute,
};
```

`coverage-guided` scores candidate scenarios using what previous histories already exercised. Unseen perturbations and unseen perturbation pairs are preferred; failure-associated perturbations receive a smaller exploitation bonus. `hybrid` layers cheap depth-1 cases, curated correlated incidents, pairwise coverage, coverage-guided candidates, and feedback-guided candidates.

For adaptive callers that want to update guidance after every execution, `@gmacko/cloudfault` also exposes `CoverageGuidance`, `coverageGuidedScenarios()`, and `exploreCoverageGuided()` directly.

## A CloudFault test

```js
import { defineCloudFault, invariant, runCheckers } from "@gmacko/cloudfault";
import { staleKvRead, serviceTimeout } from "@gmacko/cloudfault/cloudflare";

export const cloudfault = defineCloudFault({
  name: "checkout-correctness",
  strategy: "hybrid",
  maxDepth: 2,

  faultPoints: [
    {
      id: "order-visibility",
      target: "ORDER_STATE",
      choices: [staleKvRead("ORDER_STATE", {
        key: "order:812",
        region: "FRA",
        versionsBehind: 1,
      })],
    },
    {
      id: "payment-service",
      target: "PAYMENTS",
      choices: [serviceTimeout("PAYMENTS", "payment.confirm")],
    },
  ],

  async execute(scenario) {
    // Configure the real Worker/runtime boundary for scenario.perturbations,
    // exercise the workload, inspect privileged state, and return history/checks.
  },
});
```

The oracle is the application’s logical state, not the top-level HTTP status:

```text
at-most-one-charge(order)
fulfilled => paid
one-fulfillment-per-order
no-orphan-object-metadata
total-ledger-balance-conserved
versions-never-regress
eventually(all-paid-orders-converge)
```

## Runtime interception

CloudFault deliberately uses several interception layers rather than pretending one shim can impersonate every Workers binding:

```text
                           application Worker
                                  |
              +-------------------+-------------------+
              |                   |                   |
       service bindings      native storage        public APIs
              |                   |                   |
      auxiliary Worker       shape-preserving      MSW / proxy
      fetch boundaries       D1/R2 wrappers             |
              |                   |              semantic adapter
       local dependency      local D1/R2/etc.        backend
```

For Queue and Scheduled lifecycle testing, the lower-level Miniflare bridge can dispatch and transform events directly. Durable Object and Workflow fixtures use the Workers testing facilities appropriate to those primitives.

Control-plane configuration is kept separate from production application behavior. Test helpers configure Nemesis Workers through private control routes while the application continues to use ordinary Worker/service interfaces.

## Cloud semantics vs degradation

CloudFault keeps **legal distributed behavior** separate from **provider degradation**.

```text
LEGAL / CONTRACT SEMANTICS               DEGRADATION / FAILURE
--------------------------               ---------------------
KV observer lag                          D1 transient backend errors
KV stale negative observations           D1 committed-write response loss
Queue duplicate delivery                 R2 transient capacity errors
Queue rebatching                         R2 committed-write response loss
D1 session/replica visibility            Service Binding timeout/unavailability
Workflow/DO retry behavior               public API 429/5xx/disconnect
Scheduled duplicate/delay                provider commit -> lost response
```

A stale KV observation is not labeled “Cloudflare broke.” The question is whether the application remains correct while using the consistency model it selected.

`@gmacko/cloudfault/cloudflare` also includes observer traces/checkers for:

- future/impossible reads;
- monotonic observer reads;
- read-your-writes expectations;
- sequential session bookmarks; and
- cross-observer version divergence.

Logical region profiles are test models, not claims to reproduce Cloudflare’s physical POP topology.

## Provider semantics

Generic HTTP sabotage is the floor, not the goal. `semanticFirstPartyAdapters` overlays provider/capability-specific behavior on the bundled catalog. Examples include:

- Anthropic overload responses;
- GitHub secondary rate-limit behavior;
- Slack Web API HTTP-200 application errors;
- Shopify GraphQL HTTP-200 error/throttle payloads;
- streaming interruption for streaming providers;
- OAuth token expiry/revocation for OAuth-backed providers;
- regional-unavailability cases for regional cloud APIs; and
- webhook / asynchronous-job lifecycle perturbations independent of one request/response.

Adapter semantics are versionable executable artifacts:

```bash
cloudfault contracts semantic-contracts.json
cloudfault contract stripe
cloudfault semantics provider-registry.json
```

Breaking changes to a semantic contract can be detected separately from additive fault coverage. The registry records maturity/evidence so “semantic classifier” is not confused with “complete emulator.”

## Causal failure reports

Failure reports now combine:

```text
checker failures
      +
Minimal Failure Set
      +
indeterminate outcomes
      +
operation lineage
      +
process/resource ordering
      +
retry edges
      =
causal witness
```

The HTML report includes the causal edge set, indeterminate operations with actual vs observed outcome, dependency coverage, MFS, history table, and text timeline.

## Remote/staging execution

Search is runtime-agnostic. `FunctionExecutionBackend` runs locally; `RemoteHttpBackend` sends the same `Scenario` to a remote endpoint. `createRemoteExecutionHandler()` implements the versioned `cloudfault.remote-execution` protocol and exposes an optional capabilities document.

That lets the same planner/search/checker stack target a local workerd fixture, a staging proxy, or another controlled runner without changing the scenario model.

## Counterexample shrinking

Fault-set and workload minimization are intentionally distinct:

```js
const result = await shrinkCounterexample(
  perturbations,
  workload,
  ({ perturbations, workload }) => reproducesBug(perturbations, workload),
);
```

CloudFault alternates MFS reduction and sequence delta-debugging until neither witness becomes smaller. The result answers both “which failures matter?” and “what is the smallest workload that exposes them?”

## Principles

1. **Correctness, not merely uptime.** A 200 response can still leave impossible state.
2. **Legal semantics are not faults.** Consistency and delivery contracts are modeled explicitly.
3. **Indeterminate outcomes are first-class.** “Maybe committed” is different from failure.
4. **Systematic before random.** Random fuzzing complements bounded correctness search.
5. **Search the interactions.** Multi-fault combinations matter more than isolated failure injection.
6. **Minimize both witnesses.** Reduce the failure set and the workload independently.
7. **Provider semantics belong in adapters.** Business-side commit boundaries are not generic HTTP behavior.
8. **Evidence matters.** Provider semantics have maturity and contract-evidence metadata.
9. **Keep production code production-shaped.** Prefer runtime boundaries over application test branches.
10. **Do not fork workerd.** Build above Cloudflare-maintained execution wherever possible.

See [Architecture](docs/architecture.md), [Adapter Authoring](docs/adapter-authoring.md), [Provider Support](docs/provider-support.md), [Research](docs/research.md), and [Roadmap](ROADMAP.md).
