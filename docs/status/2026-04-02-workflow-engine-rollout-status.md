# Workflow Engine Rollout Status

## Last Updated

2026-04-02

## Owners

- `packages/backend`
- `packages/contracts`
- `packages/prompts`
- `docs`

## Purpose

Track current rollout state for moving from a specialized bounded review loop
to a general workflow-engine shape with first-class workflow provenance records.

Architecture reference:
`docs/architecture/workflow-engine-and-provenance-v1.md`

## Current Snapshot

- Workflow metadata is now aligned to `WorkflowRecord` + `StepRecord`.
- Step outcomes now have explicit machine-readable control signals.
- Canonical workflow termination reasons are now contract-level.
- Workflow vocabulary now uses one shared contract source for type + schema
  derivation (`WORKFLOW_STEP_*`, `WORKFLOW_TERMINATION_REASONS`).
- Backend now has a workflow-engine scaffold (`WorkflowPolicy`,
  `ExecutionLimits`, transition checks, and state/limit helpers).
- Chat bounded review loop now consults shared engine transition/limit helpers
  while preserving current behavior and fail-open semantics.

## What Is Landed

### 1) Contract Baseline (Core)

Status: `landed`

- Replaced workflow lineage naming with `WorkflowRecord` + `StepRecord`.
- Added `StepOutcome` with:
    - `status`
    - `summary`
    - `artifacts` (optional)
    - `signals` (optional, machine-readable)
    - `recommendations` (optional, advisory)
- Added explicit step kind vocabulary:
    - `plan`, `tool`, `generate`, `assess`, `revise`, `finalize`
- Added canonical termination reason vocabulary:
    - `goal_satisfied`
    - `budget_exhausted_steps`
    - `budget_exhausted_tokens`
    - `budget_exhausted_time`
    - `transition_blocked_by_policy`
    - `max_tool_calls_reached`
    - `max_deliberation_calls_reached`
    - `executor_error_fail_open`
- Added exported canonical workflow constants so unions and schema enums share
  one source of truth.

### 2) Schema + Validation Baseline (Core)

Status: `landed`

- Updated web metadata schemas to validate the new workflow record shape.
- Updated contracts schema tests for valid/invalid workflow record payloads.
- Kept `ResponseMetadataSchema` tolerant for forward compatibility.
- Added lightweight workflow invariants:
    - `stepCount === steps.length`
    - `parentStepId` must reference a step in the same workflow
    - `stepId` must be unique in each workflow
    - `parentStepId` cannot self-reference `stepId`
- Added explicit schema tests for pass/fail invariant coverage:
    - valid invariant-passing record
    - duplicate `stepId` rejection
    - missing parent rejection
    - self-parent rejection
    - `stepCount` mismatch rejection

### 3) Engine Skeleton (Backend)

Status: `landed`

- Added `workflowEngine.ts` primitives:
    - `WorkflowPolicy`
    - `ExecutionLimits`
    - `WorkflowState`
    - legal transition checks
    - execution limit checks
    - state update helpers
- Added termination reason mapping from exhausted limits.
- Added direct unit tests for engine legality and budget invariants.

## What Is Open

### 1) Replace Specialized Loop With Engine-Driven Step Routing

Status: `in_progress`

Current reality:

- Chat still executes a specialized bounded loop shape.
- Transition legality and limit checks are now shared with `workflowEngine`.
- Step routing itself is still embedded in `chatService` and not yet delegated
  to a generic engine loop.

### 2) Tool Step Generalization

Status: `pending`

Goal:

- Introduce bounded `tool` step execution with `calls[]` and
  `execution: sequential | parallel` while recording each concrete call attempt.

### 3) Deliberation Gating By Policy/Limits

Status: `in_progress`

Goal:

- Ensure model-backed deliberation is invoked only for allowed step kinds and
  within `maxDeliberationCalls`.

## Policy And Limits Boundary

- `WorkflowPolicy` owns capability toggles and legal transition rules.
- `ExecutionLimits` owns hard quantitative caps.

## Planned Runtime Controls

- `enablePlanning`
- `enableToolUse`
- `enableReplanning`
- `enableAssessment`
- `enableRevision`
- `maxWorkflowSteps`
- `maxToolCalls`
- `maxDeliberationCalls`
- `maxTokensTotal`
- `maxDurationMs`

## Next Gates

1. Delegate bounded review loop routing from `chatService` into reusable engine
   execution flow (not only helper checks).
2. Move tool execution to `tool` step shape (`calls[]` + execution mode).
3. Split provenance-facing workflow record from optional deeper debug log detail.
4. Expand policy matrix tests to include full step-route scenarios and
   fail-open decision branches.

## Open Questions

- Should `WorkflowRecord` stay fully in response metadata, or move deeper
  details to internal logs referenced by `workflowId`/`stepId`?
- Which step kinds are model-backed by default in first release profile?
- Which tool classes permit parallel mode by default?

## Validation Baseline

After edits:

- `pnpm lint:fix`

Before merge/handoff:

- `pnpm lint`
- `pnpm validate-footnote-tags`
- `pnpm validate-openapi-links` (if API boundary touched)
- `pnpm review` (cross-cutting or review-ready changes)
- `docker compose -f deploy/compose.yml build` (deploy/runtime packaging impact)

## Update Rule

Update this document in the same PR that changes workflow behavior, step
contracts, policy/limits semantics, or rollout gate status.
