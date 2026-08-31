# Research lineage

CloudFault intentionally builds on existing ideas instead of presenting its testing model as novel from whole cloth.

## Jepsen

Provides the history/nemesis/checker vocabulary and explicit support for indeterminate outcomes.

## Filibuster

Systematically injects failures into dependency calls discovered during integration tests. Its work on Distributed Execution Indexing is especially relevant for identifying equivalent dynamic calls across reruns.

## Lineage-Driven Fault Injection

Shows why systematic search over meaningful failure combinations can outperform random fault injection.

## FaultWeave

Demonstrates bounded exploration of multi-fault combinations and diagnosis through Minimal Failure Sets. Its 2026 results reinforce the importance of combinations rather than single-fault testing.

## Cast

Demonstrates that checking only top-level API responses misses silent asynchronous inconsistency. CloudFault should support deeper application-defined assertion points and convergence checks.

## fast-check

Provides property-based generation, model-based commands, reproducible seeds, shrinking, and asynchronous scheduler exploration for JavaScript/TypeScript.

## LocalStack / Speedscale / service virtualization tools

Validate demand for local cloud/API degradation testing and provide useful implementation patterns. CloudFault's intended differentiation is semantic operation modeling combined with histories and correctness invariants.
