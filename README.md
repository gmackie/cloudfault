# CloudFault

**Jepsen-lite for Cloudflare Workers.**

CloudFault systematically tests whether a Worker application remains logically correct when:

- Cloudflare behaves according to its documented distributed-system semantics;
- Cloudflare backends are temporarily degraded;
- external APIs rate-limit, fail, or return an **indeterminate** result after a side effect may already have committed; and
- retries, concurrency, duplicate delivery, stale state, and partial failure interact.

CloudFault is not a random "make 5% of requests fail" chaos library. It builds logical histories, checks application invariants, explores bounded combinations of perturbations, and reduces failures to a **Minimal Failure Set**.

```text
legal KV stale read
        +
Stripe commit -> response lost
        +
application retry with a new idempotency key
        =
duplicate payment
```

The important outcome model is:

```text
SUCCESS | DEFINITE FAILURE | INDETERMINATE
```

An indeterminate result means the caller cannot know whether an operation took effect. CloudFault preserves this as a Jepsen-style `info` completion and, when an emulator or test double has privileged knowledge, separately records the actual outcome.

## Status

CloudFault is an early implementation, but the main architecture is executable rather than aspirational:

- Jepsen-style operation histories and `ok` / `fail` / `info` outcomes;
- stable context-relative execution indexes and occurrence selectors;
- systematic depth-bounded perturbation exploration;
- 1-minimal failure-set reduction;
- replayable JSON failure artifacts and timeline rendering;
- Cloudflare KV eventual-consistency observer models;
- Queue duplicate/rebatch semantics and direct Miniflare queue dispatch;
- D1 replica/session semantics and transient-degradation models;
- Durable Object, Workflow, Scheduled, R2, and Service Binding perturbation primitives;
- Wrangler `createTestHarness()` integration and JSRPC-controlled Nemesis Workers;
- MSW-backed outbound provider interception;
- a stateful Stripe backend used for outcome-ambiguity testing;
- a public semantic adapter/plugin SDK;
- **25 bundled unofficial API adapters**; and
- source + Wrangler topology inspection from the CLI.

The bundled adapters model operations and failure semantics. They do **not** claim to be full provider emulators. A provider adapter can proxy a real sandbox/test API, sit over a stateful emulator such as `emulate`, or use a purpose-built in-memory backend like the included Stripe fixture.

## Packages

```text
@cloudfault/core          histories, controllers, checkers, search, MFS, artifacts, workloads
@cloudfault/adapter-sdk   public provider semantic adapter/plugin API + fault runtime
@cloudfault/cloudflare    Cloudflare semantics, nemesis shims, test harness/MSW/Miniflare bridges
@cloudfault/stripe        Stripe semantic adapter + stateful in-memory payment backend
@cloudfault/adapters      bundled unofficial top-25 provider semantic adapters
@cloudfault/fast-check    optional property-testing/fuzz bridge
@cloudfault/cli           run/replay/timeline/inspect/adapters/init/demo commands
```

## Development

```bash
npm install
npm test
npm run demo
```

Unit tests do not require workerd. Integration tests use Wrangler's `createTestHarness()` and therefore execute the example Workers under Cloudflare's local runtime stack.

## CLI

```bash
# inspect Worker bindings and known external API usage
npm run cloudfault -- inspect ./wrangler.jsonc ./src

# list bundled unofficial semantic adapters
npm run cloudfault -- adapters

# create a starter test config
npm run cloudfault -- init

# explore a config and write a failure artifact
npm run cloudfault -- run ./cloudfault.config.mjs

# replay the minimized perturbation set
npm run cloudfault -- replay ./.cloudfault/failures/<failure>.json

# render a saved history
npm run cloudfault -- timeline ./.cloudfault/failures/<failure>.json
```

## A CloudFault test

A test defines **fault points** and an application-specific execution function. CloudFault handles scenario enumeration, checking, and minimization.

```js
import { defineCloudFault, invariant, runCheckers } from "@cloudfault/core";
import { staleKvRead, serviceTimeout } from "@cloudfault/cloudflare";

export const cloudfault = defineCloudFault({
  name: "checkout-correctness",
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
    // Start/seed the real Worker harness, configure Nemesis Workers from
    // scenario.perturbations, exercise the workload, and return the logical
    // history + business-state checks.
  },
});
```

The test oracle is deliberately **not** just the HTTP status. Useful checkers look like:

```text
at-most-one-charge(order)
fulfilled => paid
one-fulfillment-per-order
eventually(all-paid-orders-converge)
```

## Real Worker interception paths

CloudFault uses the least invasive interception layer that matches the dependency:

```text
                         Worker under workerd
                                  |
              +-------------------+-------------------+
              |                                       |
      Cloudflare / services                      public APIs
              |                                       |
     bindingOverrides + JSRPC                      MSW node
       auxiliary Nemesis Worker                        |
              |                               semantic adapter runtime
              |                                       |
     real local dependency                    emulator / sandbox / proxy
```

For Queue and Scheduled event dispatch where the high-level harness is not enough, `@cloudfault/cloudflare` also exposes an optional direct-Miniflare bridge. Cloudflare recommends the higher-level testing APIs for normal tests and Miniflare directly for lower-level simulator control.

### D1 boundary

CloudFault models D1 failure/replica semantics, but it does **not** currently pretend that a Service Binding test Worker is a transparent D1 replacement. The D1 API's synchronous statement-builder surface (`prepare().bind()...`) is not the same shape as JSRPC. Real D1 storage continues to use the harness/local D1 binding; deeper transparent D1 fault injection requires a separate low-level interception strategy.

## Cloud semantics versus faults

CloudFault keeps two dimensions separate:

```text
LEGAL SEMANTICS                         DEGRADATION
---------------                         -----------
KV stale observer state                 D1 network/storage errors
KV stale negative lookup                R2 transient 5xx/capacity pressure
Queue duplicate delivery                Service Binding timeout/unavailability
Queue rebatching                         external API 429/5xx/disconnect
D1 replica/session visibility            provider commit -> lost response
Scheduled duplicate/delay
```

The search engine composes these with workload ordering. A stale read is not labeled "Cloudflare broke"; it is a legal state the application must tolerate if it relies on that primitive.

## Provider adapters

The adapter SDK classifies requests into semantic operations rather than endpoint strings:

```ts
{
  name: "payment_intent.create",
  effect: "external-side-effect",
  retry: "conditional",
  idempotencyKey: "order-812"
}
```

Generic reusable faults include:

```ts
rejectBeforeCommit(...)
timeoutBeforeSend(...)
commitThenTimeout(...)
commitThenDisconnect(...)
rateLimit(...)
httpError(...)
latency(...)
malformedJson(...)
```

Community adapters can use `defineRulesAdapter()` for a compact declarative implementation or implement `SemanticAdapter` directly. See [Adapter Authoring](docs/adapter-authoring.md).

The bundled unofficial catalog currently includes Stripe, GitHub, OpenAI, Anthropic, Slack, Google Workspace APIs, Microsoft Graph, AWS, Twilio, SendGrid, Resend, PayPal, Shopify, Clerk, Auth0, WorkOS, Okta, Supabase, Firebase, MongoDB Atlas, Vercel, Linear, Discord, Cloudinary, and Algolia.

## Principles

1. **Correctness, not merely uptime.** A request can return 200 and still leave impossible state.
2. **Legal semantics are not faults.** Eventual consistency and at-least-once delivery are modeled as valid behavior.
3. **Indeterminate outcomes are first-class.** "Maybe committed" is different from failure.
4. **Systematic before random.** Bounded exploration is the correctness mode; probabilistic fuzzing is complementary.
5. **Minimize the witness.** Reduce the fault set and, with property testing, the workload too.
6. **Provider semantics belong in adapters.** Generic HTTP sabotage cannot express business-side commit boundaries.
7. **Keep production code production-shaped.** Prefer binding overrides, MSW, and runtime control over test branches in application code.
8. **Do not fork workerd.** Build above Cloudflare-maintained execution wherever possible.

See [Architecture](docs/architecture.md), [Adapter Authoring](docs/adapter-authoring.md), [Provider Support](docs/provider-support.md), [Research](docs/research.md), and [Roadmap](ROADMAP.md).
