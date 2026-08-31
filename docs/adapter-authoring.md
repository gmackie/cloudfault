# Semantic adapter authoring

CloudFault adapters describe **what an operation means and how it can fail**, not merely URL mocks.

Adapters are unofficial unless a provider explicitly adopts or maintains one.

## Minimal declarative adapter

Most integrations should start with `defineRulesAdapter()`:

```ts
import { defineRulesAdapter } from "@cloudfault/adapter-sdk";

export const acmeAdapter = defineRulesAdapter({
  manifest: {
    name: "acme",
    provider: "Acme",
    unofficial: true,
    hosts: ["api.acme.example"],
    capabilities: ["rest", "idempotency"],
  },

  rules: [
    {
      methods: ["POST"],
      path: /^\/v1\/widgets$/,
      name: "widget.create",
      effect: "external-side-effect",
      retry: "conditional",
      idempotencyHeader: "Idempotency-Key",
    },
    {
      methods: ["GET"],
      path: /^\/v1\/widgets\/([^/]+)$/,
      name: "widget.get",
      effect: "query",
      retry: "safe",
      resource: (_request, match) => match?.[1],
    },
  ],
});
```

Without any custom fault code this gets a useful default fault space: provider unavailability, rate limiting, and ambiguous commit/response-loss cases for mutations.

## Full adapter contract

Use `defineAdapter()` when classification or provider behavior requires custom code:

```ts
export interface SemanticAdapter {
  manifest: AdapterManifest;
  match(request: Request): RequestMatch | null;
  faultSpace(operation: SemanticOperation, request?: Request): readonly Perturbation[];
  execute?(context: AdapterExecutionContext): Promise<Response>;
}
```

The optional `execute()` hook is for integrations that need provider-specific execution semantics. Generic adapters should prefer `AdapterRuntime` so history/outcome handling stays consistent.

## Semantic operations

Classify business meaning rather than protocol shape:

```ts
{
  name: "payment.confirm",
  effect: "external-side-effect",
  retry: "conditional",
  idempotencyKey: "order-812",
  resource: "payment:pi_123"
}
```

Available effect classes:

- `query`
- `mutation`
- `external-side-effect`
- `async-side-effect`

Retry safety is `safe`, `unsafe`, `conditional`, or `unknown`.

## Reusable faults

The SDK currently provides:

- `rejectBeforeCommit()` — definite pre-commit rejection;
- `timeoutBeforeSend()` — caller never establishes a provider operation;
- `commitThenTimeout()` — provider commits but the caller cannot observe the result;
- `commitThenDisconnect()` — same ambiguity through transport loss;
- `rateLimit()` — definite 429 with retry metadata;
- `httpError()` — provider error response;
- `latency()` — delay before the provider request; and
- `malformedJson()` — upstream responds but the caller receives invalid JSON.

The difference between `rejectBeforeCommit()` and `commitThenTimeout()` is fundamental: the former is a definite failure; the latter may make a blind retry unsafe.

## Stateful backend is optional

An adapter is **not** required to emulate the provider. `AdapterRuntime` accepts an upstream function, so the same semantic package can run over:

```text
in-memory backend
local emulator (for example emulate)
provider sandbox/test API
real upstream via MSW bypass
```

A backend that CloudFault controls can provide privileged commit knowledge. A proxied real provider may only allow `actual=unknown`, which must remain unknown in the history.

## Plugin packaging

A community package can export one adapter:

```ts
export default acmeAdapter;
```

or a plugin:

```ts
import { defineAdapterPlugin } from "@cloudfault/adapter-sdk";

export default defineAdapterPlugin({
  name: "acme-suite",
  version: "1.0.0",
  adapters: [acmeAdapter, acmeAdminAdapter],
});
```

Consumers can register it manually or load a module dynamically:

```ts
const registry = new AdapterRegistry();
await registry.loadPlugin("@acme/cloudfault-adapter");
```

## Adapter quality bar

A serious provider adapter should eventually cover:

1. high-value mutating operations;
2. resource identity where available;
3. idempotency mechanism and retry safety;
4. provider-specific 429/5xx behavior;
5. ambiguous commit boundaries;
6. asynchronous/webhook lifecycle semantics;
7. eventual visibility where the provider documents it; and
8. tests showing that its classifier does not accidentally match unrelated hosts/routes.
