# Research and reference systems

CloudFault's design is informed by several existing systems and research lines:

- Jepsen and Elle — distributed histories and consistency checking.
- Filibuster and Lineage-Driven Fault Injection — systematic dependency fault exploration.
- FaultWeave — bounded multi-fault exploration and minimal failure diagnosis.
- Cast — resilience testing with deeper internal assertions rather than HTTP-only oracles.
- fast-check — property/model-based generation, shrinking, replay, and async scheduling.
- LocalStack Chaos API — cloud-service-specific local fault injection.
- Speedscale — captured API traffic, replay, and response-level chaos.
- Toxiproxy / MockServer / WireMock — transport and HTTP fault primitives.
- emulate — independently packaged, stateful local provider emulators.

The intended differentiator is the combination of executable Cloudflare semantics, provider-specific semantic failure models, complete logical histories, application invariants, bounded multi-fault search, and minimized counterexamples.
