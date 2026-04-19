# Workflow Engine And Provenance

## Purpose

Explain the current workflow engine and the metadata it emits.

This doc covers what is implemented now, not the full plan.
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

`WorkflowEngine` runs one bounded workflow loop from start to termination.
`WorkflowPolicy` defines legal transitions and capability toggles.
`ExecutionLimits` defines hard caps for steps, calls, tokens, and time.
`WorkflowState` is the in-memory state for a running workflow.
`StepExecutor` runs one step.
`WorkflowRecord` and `StepRecord` are the workflow metadata records.

## Engine Scope

Today the engine mainly powers the reviewed chat path in
`packages/backend/src/services/workflowEngine.ts`. It handles transition
checks, hard limits, the bounded `generate -> assess -> revise` flow,
termination reasons, fail-open handling for generation/review/revise failures,
and `WorkflowRecord` plus `StepRecord` output.

The shared workflow vocabulary also includes `plan`, `tool`, and replanning or
tool-call budgets. Those terms exist in the engine, but they are not part of
the main chat path yet.

## Step Model

Step kinds are `plan`, `tool`, `generate`, `assess`, `revise`, and
`finalize`.

Some steps may be deterministic.
Some may invoke model deliberation.
That choice is controlled by `WorkflowPolicy` and `ExecutionLimits`.
Model-backed deliberation is treated as an optional capability of certain steps,
not a top-level orchestration authority.

## Review Loop

The reviewed profile uses one bounded pattern. `generate` produces the current
draft. `assess` returns `reviewDecision` and `reviewReason`. If the decision is
`revise`, `revise` produces the next draft. The loop stops when it reaches
`finalize`, hits a limit, or fails open.

## Step Records

Each `StepRecord` includes an `outcome` with `status`, `summary`, `artifacts`,
`signals`, and optional `recommendations`. This keeps step output explicit
without a separate handoff type.
`signals` means machine-readable control indicators used by transition logic
(for example `goalMet`, `needsMoreEvidence`, `toolResultQuality`), not generic telemetry.
For bounded review `assess` steps, use `reviewDecision` (`finalize` or
`revise`) plus `reviewReason` as the machine-readable output.
`recommendations` is advisory only and never overrides backend legality checks.

## Limits

`WorkflowPolicy` defines legal next steps from the current state. It also owns
capability toggles such as plan, revise, and tool enablement. Model outputs
can recommend transitions only where policy allows.

`ExecutionLimits` sets the hard caps: `maxWorkflowSteps`, `maxToolCalls`,
`maxDeliberationCalls`, `maxTokensTotal`, and `maxDurationMs`. These are
backend-enforced stops, not model suggestions.

## Failure Behavior

The current workflow can end with `goal_satisfied`,
`budget_exhausted_steps`, `budget_exhausted_tokens`,
`budget_exhausted_time`, `transition_blocked_by_policy`,
`max_tool_calls_reached`, `max_deliberation_calls_reached`, or
`executor_error_fail_open`.

## Workflow Metadata

`WorkflowRecord` is the main workflow record returned for operators and
response metadata.
Deeper runtime/debug execution detail can remain in internal logs keyed by
`workflowId` and `stepId`.

In current chat responses, planner metadata still sits alongside workflow
lineage, and workflow lineage covers the reviewed generation path. Read those
records together, but do not confuse planner influence with workflow
authority.

## Future Work

Future work may extend the same engine flow to planner and tool steps. That is
not the current first-read explanation.
Use rollout or RFC docs only when you need historical sequencing or design
tradeoffs.

Historical rollout tracking lives in
`docs/status/2026-04-workflow-engine-rollout-status.md`.
