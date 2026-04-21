# Architecture Reading Guide

Use this section to understand how Footnote is put together.

If you are new, read the core path first. The rest is useful detail, but not
the best starting point.

## Core Path

1. [Execution Contract Authority Map](./execution-contract-authority-map.md):
   start here for system authority and ownership boundaries.
2. [Workflow](./workflow.md): read this next for the
   current workflow and planner model, including mode, profile, review/revise,
   and planner boundaries.
3. [Response Metadata](./response-metadata.md):
   use this when you need the metadata map for mode, TRACE, planner influence,
   steerability, and provenance.

## Important Adjacent Docs

- [Workflow](./workflow.md): current note for workflow-facing
  wording, placement, and provenance presentation boundaries.
- [Prompt Resolution Order](./prompt-resolution.md): how prompt layers and
  overrides resolve at runtime.
- [Bounded User Control Mapping](./bounded-user-control-mapping.md): what users
  can steer directly and what stays backend-owned.
- [Execution Contract TrustGraph Architecture](./execution_contract_trustgraph/architecture.md):
  TrustGraph-specific architecture and rollout constraints.
- [Steerability Foundation (Internal Controls v1)](./2026-04-steerability-foundation.md):
  internal control-record semantics behind steerability metadata.

## Historical Workflow Notes

Read these after the docs above if you need rollout history or older design
notes. They are rationale or rollout context, not the main current explanation.

- [Workflow Profiles V1 RFC: Engine Core vs Profile Semantics](./workflow-profiles-v1-engine-vs-profile-semantics.md):
  design notes and ownership reasoning from the workflow-engine rollout.
- [Workflow Engine Rollout Status](../status/2026-04-workflow-engine-rollout-status.md):
  rollout tracking and landing history for workflow-engine work.

## Incident And Safety

- [Incident Reporting](./incident-reporting.md)
- [Incident Storage And Audit](./incident-storage-and-audit.md)
- [Incident And Breaker Logging](./incident-and-breaker-logging.md)
- [Safety Evaluation And Breakers](./risk-evaluation-and-breakers.md)
- [Deterministic Safety Evaluator V1](./deterministic-breaker-evaluator-v1.md)

## Subsystem Notes

- [Footnote and Common Agentic Patterns](./footnote-and-common-agentic-patterns.md):
  external-pattern comparison and fit.
- [Footnote Annotations](./footnote-annotations.md): code annotation conventions.
- [Tool Invocation Contract v1](./tool-invocation-contract-v1.md): tool-call
  contract details.
- [Embedding Footnote](./embedding.md): embedding-specific notes.
- [Realtime Voice System](./realtime-voice.md): implementation-oriented
  walkthrough of the current backend-owned realtime voice boundary.

## Historical Subsystem Notes

Use these only when you need older implementation snapshots or generated views.
They are not part of the main current-architecture reading path.

- [Realtime Engagement Implementation Snapshot](../status/archive/2026-04-realtime-engagement-implementation-snapshot.md):
  older Discord-side engagement note kept for historical context.
- [Dependency Graph Snapshots](../status/archive/dependency-graphs/README.md):
  generated package graph outputs and regeneration commands.
