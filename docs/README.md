# Documentation Map

Footnote keeps docs in three buckets:

- `architecture`: stable system design and interfaces
- `decisions`: durable technical choices and rationale
- `status`: implementation progress for active work

## Architecture

- [Execution Contract Authority Map](./architecture/execution-contract-authority-map.md): Defines the governing authority model and module ownership for execution.
- [Incident Reporting](./architecture/incident-reporting.md): Defines the consented Discord-side report flow and captured context.
- [Incident Storage And Audit](./architecture/incident-storage-and-audit.md): Defines the durable incident model, audit trail, and privacy boundary.
- [Incident And Breaker Logging](./architecture/incident-and-breaker-logging.md): Defines the structured logging schema and examples for incident lifecycle and breaker events.
- [Safety Evaluation And Breakers](./architecture/risk-evaluation-and-breakers.md): Defines the target deterministic safety layer and enforcement point.
- [Deterministic Breaker Evaluator V1 (Draft)](./architecture/deterministic-breaker-evaluator-v1.md): Proposes the concrete evaluator contract, rule model, action mapping, and validation gates for issue #75.
- [Prompt Resolution](./architecture/prompt-resolution.md): Defines how prompt layers and overrides resolve at runtime.
- [Workflow Profile Contract](./architecture/workflow-profile-contract.md): Defines required profile hooks/fields and blocked/no-generation behavior + provenance expectations.
- [Workflow Engine And Provenance](./architecture/workflow-engine-and-provenance.md): Defines the workflow engine direction, step model, and provenance record shape.
- [Provenance Label Taxonomy](./architecture/provenance-label-taxonomy.md): Defines canonical category boundaries for mode, TRACE, planner influence, steerability control influence, and provenance record/classification fields.
- [Workflow Profiles V1 RFC: Engine Core vs Profile Semantics](./architecture/workflow-profiles-v1-engine-vs-profile-semantics.md): Defines ownership boundaries and invariants for single-pass and bounded-review profiles.
- [Execution Contract TrustGraph Architecture](./architecture/execution_contract_trustgraph/architecture.md): Defines advisory TrustGraph integration constraints, runtime wiring, and production-readiness limits.

## Decisions

- [Turnstile Selection](./decisions/2025-10-turnstile-selection.md): Records why Turnstile was chosen for abuse protection.
- [Incident Identifier Pseudonymization](./decisions/2026-03-incident-pseudonymization.md): Records the decision to store incident-facing Discord identifiers as HMAC digests.
- [TRACE: Response Temperament + Compact UI Provenance](./decisions/2026-03-compact-provenance-TRACE.md): Records TRACE as the canonical temperament model and compact Discord provenance UI.
- [Env Parsing Standardization](./decisions/2026-03-env-parsing-standardization.md): Records the environment parsing and validation approach used across services.
- [Multi-Bot Vendoring Plan](./decisions/2026-03-multi-bot-vendoring-plan.md): Records the plan for shared backend support across multiple Discord bot identities.
- [Persona/Core Split + Out-of-Band TRACE Metadata](./decisions/2026-03-persona-core-and-trace-metadata-separation.md): Records the split between core constraints, persona layers, and control-plane metadata generation.
- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](./decisions/2026-03-legacy-openai-removal-and-runtime-branching.md): Records the end-state architecture for removing legacy OpenAI product flows across text, image, and voice.
- [VoltAgent Runtime Adoption Behind the Existing Backend](./decisions/2026-03-voltagent-runtime-adoption.md): Records why VoltAgent is being adopted behind Footnote's backend boundary and what the first MVP should prove.
- [External Pattern Adoption: Context Packaging + Tool Governance](./decisions/2026-03-external-pattern-adoption-context-and-tooling.md): Records selective adoption of external architecture patterns without platform migration.

## Status

- [Incident And Breakers Status](./status/2026-03-13-incident-breakers-status.md): Tracks current implementation progress, gaps, and validation coverage for this active work.
- [TrustGraph Foundation Consolidation Status (2026-04-10)](./status/2026-04-10-trustgraph-foundation-consolidation.md): Records bounded-scope consolidation work, runtime-truthfulness checks, and outside-review evidence anchors.
