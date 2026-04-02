# Workflow Engine Rollout Status

## Last Updated

2026-04-02

## Owners

- `packages/backend`
- `packages/contracts`
- `packages/prompts`
- `docs`

## Scope

Track the implementation plan for migrating from specialized bounded loops to a general workflow engine shape with first-class provenance records.

Architecture reference:
`docs/architecture/workflow-engine-and-provenance-v1.md`

## Current Snapshot

- Bounded review loop exists and is useful groundwork.
- Optional workflow lineage metadata exists in response metadata.
- Current runtime shape is still specialized and not yet engine-general.

## Phases

### Phase 0: Alignment And Naming

Status: `in_progress`

Goals:

- lock core names (`WorkflowEngine`, `WorkflowPolicy`, `ExecutionLimits`, `WorkflowState`, `WorkflowRecord`, `StepRecord`, `StepExecutor`),
- lock `tool` step boundary (`calls[]` + `execution` only),
- lock canonical termination reasons.

Deliverables:

- architecture document finalized,
- this status tracker initialized.

### Phase 1: Contract Baseline

Status: `pending`

Goals:

- refine workflow metadata contract for engine-style records,
- keep data serializable and explicit,
- avoid mini-language drift in step payloads.

Planned tasks:

- define v1 `WorkflowRecord` and `StepRecord` fields,
- standardize `StepRecord.outcome` fields (`status`, `summary`, `artifacts`, `signals`, optional `recommendations`),
- define step kind union (`plan`, `tool`, `generate`, `assess`, `revise`, `finalize`),
- define canonical termination reason enum.

Acceptance:

- contracts compile,
- schema tests cover valid and invalid records,
- no ambiguous optional blobs required for basic execution.

### Phase 2: Engine Skeleton In Backend

Status: `pending`

Goals:

- introduce engine abstractions without changing public route behavior yet.

Planned tasks:

- add `WorkflowEngine` orchestration loop shell,
- add `WorkflowPolicy` transition legality checks,
- add `ExecutionLimits` counters and hard-stop enforcement,
- add `StepExecutor` interface and default implementation.

Acceptance:

- existing chat behavior parity under default policy,
- deterministic termination under all limit rails,
- fail-open behavior preserved where currently expected.

### Phase 3: Migrate Current Loop To Step Execution

Status: `pending`

Goals:

- replace specialized draft/review/revise path with engine step flow.

Planned tasks:

- map current logic into `generate`/`assess`/`revise`/`finalize`,
- keep review/revision optional through policy toggles,
- keep backend cost ownership intact for all steps.

Acceptance:

- prior loop tests adapted to step model,
- lineage records generated through engine path,
- no loss of existing fail-open semantics.

### Phase 4: Tool Step Generalization

Status: `pending`

Goals:

- support bounded multi-call tool execution in one `tool` step.

Planned tasks:

- add `tool.calls[]` and `tool.execution` policy path,
- support sequential and parallel modes where policy allows,
- record each concrete tool attempt for telemetry and cost accounting,
- normalize outputs into one step outcome.

Acceptance:

- tool caps enforced (`maxToolCalls`),
- retries and failures are traceable in records,
- no subworkflow mini-language appears in the `tool` step payload.

### Phase 5: Deliberation Gating And Modes

Status: `pending`

Goals:

- make model-assisted decision points explicit and bounded.

Planned tasks:

- wire optional `DeliberationService` only for allowed step kinds,
- enforce `maxDeliberationCalls`,
- support plan-only, no-tools, single-check, and revision-disabled modes via policy.

Acceptance:

- policy toggles behave deterministically,
- model can recommend transitions only where allowed,
- backend remains authority over final legal transition.

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

## Canonical Termination Reasons (Target)

- `goal_satisfied`
- `budget_exhausted_steps`
- `budget_exhausted_tokens`
- `budget_exhausted_time`
- `transition_blocked_by_policy`
- `max_tool_calls_reached`
- `max_deliberation_calls_reached`
- `executor_error_fail_open`

## Open Questions

- Should `WorkflowRecord` live entirely in metadata, or split metadata/log detail by size sensitivity?
- Which step kinds are model-backed in first release by default?
- What is the default parallel tool execution policy per tool class?

## Validation Plan

After each implementation slice:

- `pnpm lint:fix`

Before merge/handoff:

- `pnpm lint`
- `pnpm validate-footnote-tags`
- `pnpm validate-openapi-links` (if API boundary touched)

## Update Rule

Update this document in the same PR that changes workflow engine behavior, step contracts, or rollout phase status.
