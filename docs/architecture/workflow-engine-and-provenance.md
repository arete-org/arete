# Workflow Engine And Provenance

## Purpose

Define the next orchestration shape for chat generation in Footnote.

This document is high-level and natural language.
It is intended to align architecture direction before deeper implementation details.

## Why This Exists

The current bounded review loop was a useful stepping stone.
It proved three important things:

- we can run bounded multi-step execution safely,
- we can keep fail-open behavior where policy allows,
- we can emit lineage-bearing workflow metadata.

It is not the final form.
Its current shape is still specialized around a draft/review/revise path.

Footnote now needs a general workflow engine that can support:

- optional planning,
- optional tool usage with bounded retries,
- optional model-assisted assessment,
- optional revision,
- deterministic termination under hard limits.

## Core Principles

- Backend owns orchestration legality and limits.
- Model participation is bounded and optional, not governing.
- Workflow metadata is first-class, not a sidecar.
- Keep public interfaces serializable and explicit.
- Keep fail-open defaults unless refusal policy requires blocking.
- Keep backend as cost authority.

## Terms

- `WorkflowEngine`: Runs one workflow loop from start to termination.
- `WorkflowPolicy`: Declares legal transitions and capability toggles.
- `ExecutionLimits`: Declares hard caps (steps, calls, tokens, time).
- `WorkflowState`: In-memory state used while a workflow is running.
- `StepExecutor`: Executes one step.
- `WorkflowRecord`: Curated structured artifact for provenance and operators.
- `StepRecord`: One step entry inside the workflow record.

## Control And Work Separation

Footnote separates:

- decision/control logic (what can run next),
- execution logic (run tool calls, generation, checks).

This is a responsibility split, not a 2D axis model.

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

## Tool Step Boundary

The `tool` step is intentionally simple:

- it accepts `calls[]`,
- it declares `execution: sequential | parallel`,
- it returns one normalized step outcome.

Boundary rules:

- `calls[]` must stay short and bounded.
- no internal branching mini-language inside one `tool` step.
- complex routing becomes multiple workflow steps.

Even with one `tool` step type, each concrete tool call attempt is still recorded internally for retries, costs, and provenance.

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
`recommendations` is advisory only and never overrides backend legality checks.

## Transition Legality

`WorkflowPolicy` defines legal next steps from current state.
`WorkflowPolicy` also owns capability toggles (for example plan/revise/tool enablement).
Model outputs can recommend transitions only where policy allows.
Final transition legality remains backend-owned.

## Limits And Budgeting

`ExecutionLimits` is separate from `WorkflowPolicy`.
`ExecutionLimits` owns hard quantitative caps only.
Examples:

- `maxWorkflowSteps`
- `maxToolCalls`
- `maxDeliberationCalls`
- `maxTokensTotal`
- `maxDurationMs`

These limits are hard stops enforced by backend code.

## Canonical Termination Reasons

Initial canonical reasons:

- `goal_satisfied`
- `budget_exhausted_steps`
- `budget_exhausted_tokens`
- `budget_exhausted_time`
- `transition_blocked_by_policy`
- `max_tool_calls_reached`
- `max_deliberation_calls_reached`
- `executor_error_fail_open`

## Provenance Direction

`WorkflowRecord` is the primary orchestration provenance artifact.
Execution metadata should progressively align around it.
`WorkflowRecord` is the provenance-facing curated record.
Deeper runtime/debug execution detail can remain in internal logs keyed by
`workflowId` and `stepId`.

Legacy fields may exist temporarily during migration, but they are not the target model.

## Non-Goals

- full generalized graph language,
- unlimited nested orchestration,
- cross-request memory planning framework,
- broad rollout to every route before chat stabilization.

## Rollout Strategy

- Phase 1: lock names, boundaries, and minimal record contract.
- Phase 2: build engine skeleton with current behavior parity.
- Phase 3: migrate current specialized loop to step-based execution.
- Phase 4: enable optional planning/assessment/revision modes via policy toggles.
- Phase 5: expand tool execution patterns (parallel where safe).

Status and implementation tracking lives in:
`docs/status/2026-04-02-workflow-engine-rollout-status.md`.
