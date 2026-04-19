# Architecture Reading Guide

Use this section to understand how Footnote is put together.

If you are new, read the core path first. The rest is useful detail, but not
the best starting point.

## Core Path

1. [Execution Contract Authority Map](./execution-contract-authority-map.md):
   start here for system authority and ownership boundaries.
2. [Workflow Mode Routing](./workflow-mode-routing.md): read this next for the
   current workflow and planner model, including mode, profile, review/revise,
   and planner boundaries.
3. [Workflow Engine And Provenance](./workflow-engine-and-provenance.md):
   use this after the routing doc for the current engine surface and lineage
   record shape.
4. [How to Read Provenance-Related Metadata](./provenance-label-taxonomy.md):
   use this before interpreting TRACE, provenance, mode, or planner fields in
   responses.

## Important Adjacent Docs

- [Workflow Profile Contract](./workflow-profile-contract.md): contract details
  for executable workflow profiles, limits, and no-generation handling.
- [Prompt Resolution Order](./prompt-resolution.md): how prompt layers and
  overrides resolve at runtime.
- [Bounded User Control Mapping](./bounded-user-control-mapping.md): what users
  can steer directly and what stays backend-owned.
- [Execution Contract TrustGraph Architecture](./execution_contract_trustgraph/architecture.md):
  TrustGraph-specific architecture and rollout constraints.
- [Steerability Foundation (Internal Controls v1)](./2026-04-steerability-foundation.md):
  the control-plane foundation behind bounded user control and runtime posture.

## Historical Workflow Notes

These are useful after you understand the current docs above.
They are not the best first read for the current workflow/planner shape.

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

## Supplemental Context

- [Footnote and Common Agentic Patterns](./footnote-and-common-agentic-patterns.md):
  external-pattern comparison and fit.
- [Footnote Annotations](./footnote-annotations.md): code annotation conventions.
- [Tool Invocation Contract v1](./tool-invocation-contract-v1.md): tool-call
  contract details.
- [Embedding Footnote](./embedding.md): embedding-specific notes.
- [Realtime Engagement System](./realtime-engagement.md)
- [Realtime Voice System](./realtime-voice.md)
- [Dependency Graphs](./dependency-graphs/README.md): generated package graphs.
