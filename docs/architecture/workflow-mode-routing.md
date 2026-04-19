# Workflow Mode Routing

## Purpose

A workflow mode is the routing choice for one chat request.

This is the main doc for workflow and planner behavior today.
Read this before the profile contract, rollout notes, or RFC material.

The Execution Contract sets the limits. Workflow mode picks the kind of run.
Workflow profile picks the step pattern. Planner can suggest how to carry out
the run, but it cannot change the rules. Workflow lineage records what
happened.

## Runtime Flow

The backend resolves an Execution Contract preset first. Then it resolves a
workflow mode, maps that mode to a workflow profile and runtime limits, and
runs planner once in `chatOrchestrator` before message generation. Planner
output still goes through surface policy, capability policy, and tool policy.
`chatService` then runs either direct generation or the bounded review loop.
Response metadata records `workflowMode`, planner execution details, and
workflow lineage.

Planner affects execution today, but it is not yet a first-class workflow step
in workflow metadata.

## Modes And Profiles

The mode ids are `fast`, `balanced`, and `grounded`.

| Mode       | Contract preset    | Workflow profile | Flow                     | Review | Revise | Evidence | Notes                                      |
| ---------- | ------------------ | ---------------- | ------------------------ | ------ | ------ | -------- | ------------------------------------------ |
| `fast`     | `fast-direct`      | `generate-only`  | single-pass generation   | no     | no     | minimal  | no workflow review loop                    |
| `balanced` | `balanced`         | `bounded-review` | reviewed generation path | yes    | yes    | balanced | same profile as `grounded`, lighter limits |
| `grounded` | `quality-grounded` | `bounded-review` | reviewed generation path | yes    | yes    | strict   | workflow execution is policy-gated         |

`balanced` and `grounded` share one profile today. The difference is in the
contract preset and limits, not in the step pattern.

## Selection

1. Use the requested mode when it is recognized.
2. Otherwise, if the Execution Contract provides a response mode, map it to canonical mode (`quality_grounded` -> `grounded`, `fast_direct` -> `fast`).
3. Otherwise, fall back to `grounded`.

This keeps the system available while preferring the more careful default.
These fallback steps happen only during initial routing. They are not runtime
mode escalation.

## Review Loop

`generate-only` runs one `generate` step and stops. `bounded-review` runs
`generate -> assess -> revise` in a bounded loop.

The assess step emits two machine-readable fields: `reviewDecision`
(`finalize` or `revise`) and `reviewReason`. A review result can request a
revision, but it does not bypass workflow policy or engine limits.

## Planner Boundary

Planner can choose an action shape for the request, suggest search or tool
details, suggest a capability profile, and affect execution metadata when its
output materially mattered. It cannot change the Execution Contract, grant
itself extra tools or steps, bypass policy, or become the final authority on
mode, profile, safety, or provenance.

Today, planner runs in `chatOrchestrator` before `chatService` starts the
review loop.
Planner execution is recorded in `metadata.execution[]` and in steerability
metadata, but workflow lineage still starts with the generation/review path.

## Future Work

Today, planner is still frontloaded in orchestration. The workflow engine runs
the reviewed generation path. `plan` and `tool` exist in the shared workflow
vocabulary, but they are not the main current chat path.

Future work includes planner as a workflow step, tool steps under the same
engine, and clearer correlation if planner passes or retries are added later.
That does not change the current rule: planner is advisory, and the workflow
engine does not yet own planner timing in the current chat path.

## Mode Escalation

Workflow mode escalation is attached at one place in
`resolveWorkflowRuntimeConfig` (`packages/backend/src/services/workflowProfileRegistry.ts`).

Rules for this seam:

- Resolve initial mode once using the normal selection order.
- Optionally apply one workflow-owned escalation request.
- Never run recursive or unbounded mode re-evaluation loops.
- Keep escalation routing centralized in workflow resolver code, not callers.

## Metadata

`workflowMode` in response metadata records `modeId`, `selectedBy`,
`selectionReason`, `initial_mode`, optional `escalated_mode`, optional
`escalation_reason`, optional `requestedModeId`, optional
`executionContractResponseMode`, and `behavior`.

Use the nearby metadata fields for different jobs.
`metadata.workflowMode.*` explains the routing choice.
`metadata.execution[]` planner entries explain planner influence.
`metadata.workflow` records workflow lineage.
TRACE fields describe answer behavior, not workflow routing.
