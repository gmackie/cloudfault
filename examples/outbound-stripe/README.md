# Outbound Stripe/MSW fixture

This fixture runs a Worker through Wrangler `createTestHarness()` while the Worker performs an ordinary outbound `fetch()` to `api.stripe.com`.

On the Node side, CloudFault creates an MSW server backed by:

```text
Stripe semantic adapter
        +
ScenarioController
        +
StripeMemoryBackend
```

For `commit-then-timeout`, the backend processes the payment first, CloudFault records the actual committed outcome, and MSW turns the caller-facing result into a network failure. The intentionally unsafe Worker retries with a fresh idempotency key and creates a duplicate charge. A variant using a stable idempotency key remains correct.
