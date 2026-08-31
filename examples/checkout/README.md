# Checkout binding-override fixture

This fixture exercises a production-shaped Worker under Wrangler `createTestHarness()`.

The application uses:

- `ORDER_STATE` — KV-shaped binding;
- `DB` — real local D1 binding;
- `FULFILLMENT` — Queue producer-shaped binding; and
- `PAYMENTS` — Service Binding.

For the test, `bindingOverrides` replaces KV, Queue, and payment-service edges with JSRPC-controllable Nemesis Workers. D1 remains a native D1 binding because a Service Binding cannot transparently reproduce D1's synchronous statement-builder API.

The intentional application bug retries an indeterminate payment with a fresh idempotency key. The important scenario is:

```text
KV observer sees stale PENDING
        +
payment service commits then response is lost
        +
application retries
        =
two charges
```

The test demonstrates that neither perturbation alone breaks `at-most-one-new-charge`, while the combination does and reduces to that two-element Minimal Failure Set.
