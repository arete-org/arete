# Workflow Engine Rollout Status

## Last Updated

2026-04-12

## Owners

- `packages/backend`
- `packages/contracts`
- `packages/prompts`
- `docs`

## Purpose

Track current rollout state for moving from a specialized bounded review loop
to a general workflow engine with first-class workflow provenance records.

Read this after the current architecture docs. It is a rollout tracker, not
the main workflow/planner explainer.

Current architecture references:

- `docs/architecture/workflow-runtime.md`
- `docs/architecture/workflow-language.md`

## Snapshot

- Workflow metadata is now aligned to `WorkflowRecord` + `StepRecord`.
- Step outcomes now have explicit machine-readable control signals.
- Bounded review assess steps now emit canonical machine-readable decision and
  reason signals in lineage (`reviewDecision`, `reviewReason`).
- Workflow termination reasons are now contract-level.
- Workflow profile contract now documents required profile hooks,
  blocked/no-generation behavior, and no-generation provenance invariants.
- Workflow vocabulary now uses one shared contract source for type + schema
  derivation (`WORKFLOW_STEP_*`, `WORKFLOW_TERMINATION_REASONS`).
- Backend now has a workflow-engine scaffold (`WorkflowPolicy`,
  `ExecutionLimits`, transition checks, and state/limit helpers).
- Chat bounded review loop routing is now delegated through
  `runBoundedReviewWorkflow`, with legality enforced before each bounded step.
- Planner still runs in `chatOrchestrator` before workflow execution; planner
  as first-class workflow step remains future work.

## Landed Work

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
- Added termination reason vocabulary:
    - `goal_satisfied`
    - `budget_exhausted_steps`
    - `budget_exhausted_tokens`
    - `budget_exhausted_time`
    - `transition_blocked_by_policy`
    - `max_tool_calls_reached`
    - `max_deliberation_calls_reached`
    - `executor_error_fail_open`
- Added exported workflow constants so unions and schema enums share
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

## Open Work

### 1) Replace Specialized Loop With Engine-Driven Step Routing

Status: `landed`

Current reality:

- Current bounded review routing and termination now execute via
  `workflowEngine` runtime entrypoint.
- `chatService` remains the adapter layer for request composition and metadata
  assembly.

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

### 4) Planner As Workflow Step

Status: `pending`

Goal:

- Move planner from orchestrator-frontloaded execution into first-class
  workflow lineage without giving planner extra policy authority.

## Policy And Limits

`WorkflowPolicy` owns capability toggles and legal transition rules.
`ExecutionLimits` owns hard quantitative caps.

## Runtime Controls (Current Chat Profile)

Active in current bounded review-loop execution:

- `maxWorkflowSteps`
- `maxDeliberationCalls`
- `maxDurationMs`

Present in shared types but intentionally inert/deferred in this PR:

- `maxToolCalls` (no `tool` step routed in current chat loop)
- `maxTokensTotal` (no total-token cap wiring in current chat loop)

Planned/inactive policy capability toggles in current chat loop:

- `enablePlanning`
- `enableToolUse`
- `enableReplanning`

Active policy capability toggles in current chat loop:

- `enableAssessment` (active with current profile policy = `true`)
- `enableRevision` (active with current profile policy = `true`)

## Next Gates

1. Delegate bounded review loop routing from `chatService` into reusable engine
   execution flow (not only helper checks). ✅
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
