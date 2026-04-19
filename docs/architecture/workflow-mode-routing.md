# Workflow Mode Routing

## Purpose

A workflow mode is the high-level routing choice for one chat request.

This is the main current-shape doc for workflow and planner behavior.
Read this before the profile contract, rollout notes, or RFC material.

The short version:

- the Execution Contract governs allowed posture and limits,
- workflow mode chooses the kind of run,
- workflow profile chooses the executable step pattern,
- planner can suggest execution details but does not gain policy authority,
- workflow lineage records what actually happened.

Keep those jobs separate.
The Execution Contract answers "what kind of run is allowed?"
Workflow mode answers "which current posture did we choose?"
Workflow profile answers "which step pattern executes that posture?"
Planner answers "what action details should this run try?"
Those are related, but they are not the same thing.

## Current Runtime Shape

Today the request path looks like this:

1. The backend resolves an Execution Contract preset.
2. Workflow mode is resolved as `fast`, `balanced`, or `grounded`.
3. That mode maps to a workflow profile and runtime limits.
4. `chatOrchestrator` invokes planner once, before message generation.
5. Planner output is filtered through surface policy, capability policy, and
   tool policy.
6. `chatService` either runs direct generation or the bounded review workflow.
7. Response metadata records `workflowMode`, planner execution details, and
   workflow lineage.

That means planner is execution-relevant today, but it is not yet a
first-class workflow-engine step in runtime lineage.

## Mode Set

Canonical mode ids are `fast`, `balanced`, and `grounded`.

| Mode       | Contract preset    | Workflow profile | Current execution shape                   | Review | Revise | Evidence posture | Notes                                      |
| ---------- | ------------------ | ---------------- | ----------------------------------------- | ------ | ------ | ---------------- | ------------------------------------------ |
| `fast`     | `fast-direct`      | `generate-only`  | single-pass generation                    | no     | no     | minimal          | no workflow review loop                    |
| `balanced` | `balanced`         | `bounded-review` | reviewed workflow path                    | yes    | yes    | balanced         | same profile as `grounded`, lighter limits |
| `grounded` | `quality-grounded` | `bounded-review` | reviewed workflow path with stricter caps | yes    | yes    | strict           | workflow execution is policy-gated         |

`balanced` and `grounded` share one profile today.
That is why mode and profile stay separate.
Mode carries posture and limits.
Profile carries executable shape.

## Selection Order

1. Use the requested mode when it is recognized.
2. Otherwise, if the Execution Contract provides a response mode, map it to canonical mode (`quality_grounded` -> `grounded`, `fast_direct` -> `fast`).
3. Otherwise, fall back to `grounded`.

This keeps the system available while preferring the more careful default
posture.
These fallback steps are initial routing fallback only. They are not runtime
mode escalation.

## Review And Revise Behavior

The current profiles are simple on purpose:

- `generate-only` means one `generate` step and stop.
- `bounded-review` means `generate -> assess -> revise` in a bounded loop.

The assess step emits the canonical machine-readable review outcome:

- `reviewDecision`: `finalize` or `revise`
- `reviewReason`: one short explanation

That assess output can request revision, but it still does not bypass engine
limits or workflow policy.
The engine decides whether another step is legal.

## Planner Boundary

Planner is intentionally bounded.

Planner can:

- choose an action shape for the request,
- suggest search/tool usage details,
- suggest a capability profile,
- influence execution metadata when its output materially mattered.

Planner cannot:

- change the Execution Contract,
- grant itself extra tools or extra steps,
- bypass surface policy or capability policy,
- become the final authority on mode, profile, safety, or provenance.

Today, planner runs in `chatOrchestrator` before `chatService` begins the
review workflow.
Planner execution is recorded in `metadata.execution[]` and in steerability
metadata, but workflow lineage still starts with the generation/review path.

## Current And Future Line

Current behavior:

- planner is orchestrator-frontloaded,
- workflow engine is used for the reviewed generation path,
- `plan` and `tool` are part of the shared workflow vocabulary but are not the
  main current chat path,
- review/revise are real runtime behavior today.

Future direction:

- planner-as-workflow-step,
- tool steps under the same workflow engine,
- clearer correlation if multiple planner passes or retries ever exist.

Do not read the future direction back into current authority.
Planner is still advisory.
Workflow engine does not yet own planner execution timing in the current chat
path.

## Escalation Seam

Workflow mode escalation is attached at one bounded seam in
`resolveWorkflowRuntimeConfig` (`packages/backend/src/services/workflowProfileRegistry.ts`).

Rules for this seam:

- Resolve initial mode once using the normal selection order.
- Optionally apply one workflow-owned escalation request.
- Never run recursive or unbounded mode re-evaluation loops.
- Keep escalation routing centralized in workflow resolver code, not callers.

## Metadata Contract

`workflowMode` in response metadata records `modeId`, `selectedBy`,
`selectionReason`, `initial_mode`, optional `escalated_mode`, optional
`escalation_reason`, optional `requestedModeId`, optional
`executionContractResponseMode`, and `behavior` (the concrete mapped behavior
tuple).

Use nearby metadata like this:

- `metadata.workflowMode.*` explains the routing choice.
- `metadata.execution[]` planner entries explain planner influence.
- `metadata.workflow` explains the executed workflow lineage.
- TRACE fields explain answer posture, not workflow routing.
