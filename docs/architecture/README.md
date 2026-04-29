# Architecture Reading Guide

Use this section to understand how Footnote is put together.

If you are new, start with the first few items below. The later items add more
detail once you have the main runtime shape in mind.

## Important Concepts

1. [Execution Contract Authority Map](./execution-contract-authority-map.md):
   start here for system authority and ownership boundaries.
2. [Workflow](./workflow.md): read this next for the
   current workflow and planner model, including mode, profile, review/revise,
   planner boundaries, workflow-facing wording, placement, and provenance
   presentation boundaries.
3. [Answer Posture And Control Influence](./answer-posture-and-control-influence.md):
   use this when you need the metadata map for mode, TRACE, planner influence,
   control influence, and provenance.
4. [Prompt Resolution Order](./prompt-resolution.md): how prompt layers and
   overrides resolve at runtime.
5. [Bounded User Control Mapping](./bounded-user-control-mapping.md): what
   users can steer directly and what stays backend-owned.
6. [Execution Contract TrustGraph Architecture](./execution_contract_trustgraph/architecture.md):
   TrustGraph-specific architecture and rollout constraints.

## Active Workflow Note

- [Workflow Rollout Status](../status/2026-04-workflow-engine-rollout-status.md):
  active note for the small amount of workflow work that is still open after
  the main workflow architecture described in [Workflow](./workflow.md).

## Incident And Safety

- [Incident Handling](./incident-handling.md)
- [Safety Evaluation](./safety-evaluation.md)

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
