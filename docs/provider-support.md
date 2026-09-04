# Provider support

`@gmacko/cloudfault/adapters` currently bundles 25 **unofficial semantic adapters**.

| Adapter | Primary semantic focus |
| --- | --- |
| Stripe | payment intents, confirmation, refunds, idempotency, ambiguous payment commit |
| GitHub | REST/GraphQL mutations, rate limiting, webhooks |
| OpenAI | responses/chat operations, streaming/long requests, rate limiting |
| Anthropic | message creation/streaming, rate limiting |
| Slack | message side effects and Web API rate limiting |
| Google | Workspace API request classification and mutations |
| Microsoft Graph | Graph reads/mutations and identity-backed API calls |
| AWS | regional service API actions across `*.amazonaws.com` |
| Twilio | messaging/telephony side effects and callback-driven state |
| SendGrid | email sends and delivery lifecycle |
| Resend | email sends and webhook lifecycle |
| PayPal | order capture/refund style payment transitions + request IDs |
| Shopify | Admin API GraphQL/REST mutations and throttling |
| Clerk | identity/session management operations |
| Auth0 | identity/OAuth management operations |
| WorkOS | enterprise identity/directory operations |
| Okta | identity/OIDC management operations |
| Supabase | hosted API requests across project subdomains |
| Firebase | Firebase REST-facing APIs |
| MongoDB Atlas | Atlas administration/data API operations |
| Vercel | deployment/project mutation workflows |
| Linear | GraphQL queries/mutations and webhooks |
| Discord | REST/bot mutations and rate limiting |
| Cloudinary | upload/asset mutations |
| Algolia | index query/write operations and eventual index visibility candidates |

This table means CloudFault can identify important operation classes and generate useful generic semantic faults. It does **not** mean every endpoint or provider-specific state machine is emulated.

## Support levels

CloudFault should describe adapter maturity explicitly:

- **classifier** — recognizes provider operations and basic query/mutation semantics;
- **semantic** — provider-specific idempotency, rate-limit, commit, consistency, or webhook semantics;
- **stateful** — maintained emulator/backend capable of revealing actual committed state;
- **conformance** — exercised against a provider sandbox or contract suite.

Stripe is currently the deepest bundled adapter and includes a small stateful backend used by the integration tests. Other adapters are primarily classifier/semantic-level and can proxy provider sandboxes or third-party emulators.
