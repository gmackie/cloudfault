# Adapter authoring

CloudFault adapters classify external interactions into semantic operations and describe how those operations can fail.

An adapter does not need to implement the provider itself. It may use synthetic responses, proxy a real sandbox endpoint, or sit in front of a stateful emulator.

```ts
import { defineAdapter, mutation } from "@cloudfault/adapter-sdk";

export default defineAdapter({
  manifest: {
    name: "acme",
    provider: "Acme",
    unofficial: true,
    hosts: ["api.acme.example"]
  },
  operations: [
    mutation("widget.create", {
      match: {
        method: "POST",
        path: /^\/v1\/widgets$/
      },
      semantics: {
        sideEffect: true,
        externallyVisible: true,
        idempotency: "key-supported",
        ambiguityRisk: "high"
      }
    })
  ]
});
```

Adapters can declare semantic fault templates such as:

- failure before the provider commits,
- provider commit followed by timeout,
- provider commit followed by disconnect,
- rate limiting,
- malformed responses.

Higher-level adapters may additionally model webhooks, eventual visibility, async jobs, provider state machines, or recommend application invariants.

The adapter API is intentionally public from V0 so provider-specific behavior never becomes hard-coded into CloudFault core.
