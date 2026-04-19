# Workflow Engine And Provenance

## Purpose

Explain the current workflow-engine surface and the provenance record it emits.

This doc is about what is implemented now, not the full target direction.
Read [Workflow Mode Routing](./workflow-mode-routing.md) first if you need the
big picture.

## Core Principles

- Backend owns orchestration legality and limits.
- Model participation is bounded and optional, not governing.
- Workflow metadata is first-class, not a sidecar.
- Keep public interfaces serializable and explicit.
- Keep fail-open defaults unless refusal policy requires blocking.
- Keep backend as cost authority.

## Terms

- `WorkflowEngine`: Runs one bounded workflow loop from start to termination.
- `WorkflowPolicy`: Declares legal transitions and capability toggles.
- `ExecutionLimits`: Declares hard caps (steps, calls, tokens, time).
- `WorkflowState`: In-memory state used while a workflow is running.
- `StepExecutor`: Executes one step.
- `WorkflowRecord`: Curated structured artifact for provenance and operators.
- `StepRecord`: One step entry inside the workflow record.

## Current Engine Scope

Today the engine mainly powers the reviewed chat path in
`packages/backend/src/services/workflowEngine.ts`.

What is active now:

- legal transition checks,
- hard execution limits,
- bounded `generate -> assess -> revise` execution,
- canonical termination reasons,
- fail-open handling for generation/review/revise failures,
- `WorkflowRecord` and `StepRecord` lineage output.

What is vocabulary now but not the main current chat path:

- `plan`
- `tool`
- replanning/tool-call budgets beyond current reviewed generation flow

## Step Model

Step kinds:

- `plan`
- `tool`
- `generate`
- `assess`
- `revise`
- `finalize`

Some steps may be deterministic.
Some may invoke model deliberation.
That choice is controlled by `WorkflowPolicy` and `ExecutionLimits`.
Model-backed deliberation is treated as an optional capability of certain steps,
not a top-level orchestration authority.

## Current Review Loop

The reviewed profile uses one bounded pattern:

1. `generate` produces the current draft.
2. `assess` returns `reviewDecision` and `reviewReason`.
3. If the decision is `revise`, `revise` produces the next draft.
4. The loop stops when it reaches `finalize`, hits a limit, or fails open.

This is the current runtime path behind review and revise behavior.
It is not just a target design note.

## Outcome Shape

Each `StepRecord` includes an `outcome` with minimal typed fields:

- `status`
- `summary`
- `artifacts`
- `signals`
- `recommendations` (optional)

This keeps handoff data explicit without a separate top-level handoff type.
`signals` means machine-readable control indicators used by transition logic
(for example `goalMet`, `needsMoreEvidence`, `toolResultQuality`), not generic telemetry.
For bounded review `assess` steps, use `reviewDecision` (`finalize` or `revise`)
plus `reviewReason` as the canonical machine output seam.
`recommendations` is advisory only and never overrides backend legality checks.

## Transition And Limit Ownership

`WorkflowPolicy` defines legal next steps from current state.
`WorkflowPolicy` also owns capability toggles (for example plan/revise/tool enablement).
Model outputs can recommend transitions only where policy allows.
Final transition legality remains backend-owned.

`ExecutionLimits` owns the hard caps:

- `maxWorkflowSteps`
- `maxToolCalls`
- `maxDeliberationCalls`
- `maxTokensTotal`
- `maxDurationMs`

These are backend-enforced stops, not model suggestions.

## Termination Reasons

Initial reasons:

- `goal_satisfied`
- `budget_exhausted_steps`
- `budget_exhausted_tokens`
- `budget_exhausted_time`
- `transition_blocked_by_policy`
- `max_tool_calls_reached`
- `max_deliberation_calls_reached`
- `executor_error_fail_open`

## Provenance Shape

`WorkflowRecord` is the primary orchestration provenance artifact.
`WorkflowRecord` is the provenance-facing curated record.
Deeper runtime/debug execution detail can remain in internal logs keyed by
`workflowId` and `stepId`.

In current chat responses:

- planner metadata still lives alongside workflow lineage,
- workflow lineage covers the reviewed generation path,
- the two should be read together without confusing planner influence for
  workflow authority.

## Future Direction

Future work may extend the same engine shape to planner and tool steps.
That is not the current first-read explanation.
Use rollout or RFC docs only when you need historical sequencing or design
tradeoffs.

Historical rollout tracking lives in
`docs/status/2026-04-workflow-engine-rollout-status.md`.
