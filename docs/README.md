# Documentation Map

Footnote keeps docs in three buckets:

- `architecture`: stable system design and interfaces
- `decisions`: durable technical choices and rationale
- `status`: implementation progress for active work

## Architecture

- [Incident Reporting](./architecture/incident-reporting.md): Defines the consented Discord-side report flow and captured context.
- [Incident Storage And Audit](./architecture/incident-storage-and-audit.md): Defines the durable incident model, audit trail, and privacy boundary.
- [Risk Evaluation And Breakers](./architecture/risk-evaluation-and-breakers.md): Defines the target deterministic safety layer and enforcement point.
- [Prompt Resolution](./architecture/prompt-resolution.md): Defines how prompt layers and overrides resolve at runtime.

## Decisions

- [Turnstile Selection](./decisions/2025-10-turnstile-selection.md): Records why Turnstile was chosen for abuse protection.
- [Incident Identifier Pseudonymization](./decisions/2026-03-incident-pseudonymization.md): Records the decision to store incident-facing Discord identifiers as HMAC digests.
- [TRACE: Response Temperament + Compact UI Provenance](./decisions/2026-03-compact-provenance-TRACE.md): Records TRACE as the canonical temperament model and compact Discord provenance UI.
- [Env Parsing Standardization](./decisions/2026-03-env-parsing-standardization.md): Records the environment parsing and validation approach used across services.
- [Multi-Bot Vendoring Plan](./decisions/2026-03-multi-bot-vendoring-plan.md): Records the plan for shared backend support across multiple Discord bot identities.
- [Persona/Core Split + Out-of-Band TRACE Metadata](./decisions/2026-03-persona-core-and-trace-metadata-separation.md): Records the split between core constraints, persona layers, and control-plane metadata generation.
- [VoltAgent Runtime Adoption Behind the Existing Backend](./decisions/2026-03-voltagent-runtime-adoption.md): Records why VoltAgent is being adopted behind Footnote's backend boundary and what the first MVP should prove.

## Status

- [Incident And Breakers Status](./status/incident-breakers-status.md): Tracks current implementation progress, gaps, and validation coverage for this active work.
- [VoltAgent Reflect Runtime Status](./status/voltagent-reflect-runtime-status.md): Tracks the staged MVP migration of backend reflect generation onto a VoltAgent-backed runtime boundary.
