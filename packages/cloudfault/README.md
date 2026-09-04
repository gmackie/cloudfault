# @gmacko/cloudfault

**Jepsen-lite for Cloudflare Workers.**

CloudFault systematically tests whether a Worker application stays *logically correct* when Cloudflare primitives, external APIs, retries, concurrency, stale observations, duplicate delivery, backend degradation, and ambiguous side effects interact.

It is not a "make 5% of requests fail" chaos library. CloudFault builds logical histories, explores bounded and coverage-guided perturbation combinations, checks business invariants, and reduces every failure to two independent witnesses:

1. the **Minimal Failure Set** — the smallest set of perturbations that still reproduces the bug; and
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

The outcome model is deliberately three-valued — `SUCCESS | DEFINITE FAILURE | INDETERMINATE`. An indeterminate operation becomes a Jepsen-style `info` completion, and when a stateful emulator or test backend has privileged knowledge, CloudFault records what the provider *actually* did separately from what the application *observed*.

## Install

```bash
npm install --save-dev @gmacko/cloudfault
```

Requires Node.js >= 20. Everything is bundled into this one package; there is nothing else to install.

Optional peers, only needed for the features that use them:

| Peer | Needed for |
| --- | --- |
| `wrangler` | real workerd builds via `@gmacko/cloudfault/cloudflare` |
| `miniflare` | Queue/Scheduled/Durable Object lifecycle control |
| `msw` | outbound HTTP interception for provider adapters |
| `fast-check` | the property-testing bridge at `@gmacko/cloudfault/fast-check` |

## Entry points

```ts
import { defineCloudFault, runCloudFault } from "@gmacko/cloudfault";        // core
import { staleKvRead, createCloudFaultHarness } from "@gmacko/cloudfault/cloudflare";
import { stripeAdapter } from "@gmacko/cloudfault/stripe";
import { defineRulesAdapter } from "@gmacko/cloudfault/adapter-sdk";
import { firstPartyAdapters } from "@gmacko/cloudfault/adapters";
import { findScenarioCounterexample } from "@gmacko/cloudfault/fast-check";
```

| Subpath | Contents |
| --- | --- |
| `@gmacko/cloudfault` | history, lineage, search, MFS reduction, oracles, diagnostics, reports, execution backends |
| `@gmacko/cloudfault/cloudflare` | KV/D1/R2/Queue/Durable Object/Workflow/Scheduled/Service semantics, workerd + Miniflare + MSW bridges |
| `@gmacko/cloudfault/stripe` | Stripe semantic adapter and a stateful in-memory payment backend |
| `@gmacko/cloudfault/adapter-sdk` | semantic adapter API — also `/capabilities`, `/conformance`, `/contracts`, `/signers`, `/emulate` |
| `@gmacko/cloudfault/adapters` | 25 bundled unofficial provider adapters with capability-aware semantic overlays |
| `@gmacko/cloudfault/fast-check` | property-testing bridge — also `/shrink` and `/model-shrink` |

Bundled adapters model a useful semantic subset. They do **not** claim to be complete provider emulators. An adapter can use synthetic responses, proxy a real sandbox API, sit over a stateful emulator such as [`@gmacko/emulate`](https://www.npmjs.com/package/@gmacko/emulate), or use a purpose-built backend like the included Stripe fixture.

## A CloudFault test

```ts
// cloudfault.config.mjs
import { defineCloudFault } from "@gmacko/cloudfault";
import { staleKvRead, d1CommitThenTimeout, duplicateQueueDelivery } from "@gmacko/cloudfault/cloudflare";

export const cloudfault = defineCloudFault({
  name: "checkout-api",
  strategy: "hybrid",
  maxDepth: 2,
  maxScenarios: 100,
  cache: "file",
  faultPoints: [
    staleKvRead("CONFIG"),
    d1CommitThenTimeout("DB"),
    duplicateQueueDelivery("FULFILLMENT"),
  ],
  async execute(scenario) {
    // start your harness, apply the scenario's perturbations, drive a
    // production-shaped workload, then return the observed history.
    return { scenario, history, checks, state };
  },
});
```

```bash
npx cloudfault plan cloudfault.config.mjs   # what would run, and what it costs
npx cloudfault run  cloudfault.config.mjs   # explore, check invariants, minimise
```

## CLI

The package installs a `cloudfault` binary.

```bash
npx cloudfault inspect wrangler.jsonc   # bindings + provider usage -> recommended tests
npx cloudfault init                     # project-aware starter config
npx cloudfault doctor                   # dependencies, topology, semantic coverage
npx cloudfault plan cloudfault.config.mjs
npx cloudfault run cloudfault.config.mjs
npx cloudfault replay .cloudfault/failure.json
npx cloudfault timeline .cloudfault/failure.json
npx cloudfault adapters                 # bundled provider support
npx cloudfault contracts                # versioned executable semantics artifacts
npx cloudfault demo                     # stale-read + ambiguous-commit walkthrough
```

## Search strategies

`exhaustive` (bounded depth-N), `pairwise`, `guided` (failure-feedback), `coverage-guided` (lineage-driven), `incidents` (curated real-world outage shapes), and `hybrid`, which runs depth-1 diagnostics first and then blends the rest without exploding the full Cartesian product.

Failures are reduced twice — once over the fault set (1-minimal MFS) and once over the workload (delta debugging) — and reported as JSON, JUnit, GitHub Actions annotations, a text timeline, or HTML.

## Status

CloudFault is experimental but executable, and pre-1.0: the API may change between minor versions. The repository's CI runs real workerd/Miniflare/Vitest fixtures against a pinned Wrangler stack, so Cloudflare runtime drift is caught rather than hidden behind mocks.

Full documentation, examples, and the roadmap live at **[github.com/gmackie/cloudfault](https://github.com/gmackie/cloudfault)**.

## License

MIT © Graham Mackie
