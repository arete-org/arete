# Canonical Workflow Profile Contract

## Purpose

Define one contract for workflow profiles before multi-profile execution is introduced.

This removes ambiguity for blocked/no-generation handling and provenance.

## Scope

This document defines:

- canonical profile contract shape,
- blocked/no-generation behavior matrix,
- required termination-reason mapping,
- provenance requirements for blocked-before-generation and no-generation,
- compatibility notes for `bounded-review` and `generate-only`.

Out of scope:

- profile registry runtime implementation,
- plan-and-generate or tool-assisted profile implementation,
- blocked-state UI redesign.

## Canonical Contract Shape

Type baseline (low risk, backend-local):
`packages/backend/src/services/workflowProfileContract.ts`

Required fields:

- `profileId`: stable key (for example `bounded-review`, `generate-only`).
- `profileVersion`: currently fixed to `v1`.
- `displayName`: human-readable name.
- `workflowName`: provenance-facing workflow identifier.
- `policy`: explicit capability toggles (`enablePlanning`, `enableToolUse`, `enableReplanning`, `enableGeneration`, `enableAssessment`, `enableRevision`).
- `defaultLimits`: explicit quantitative limits (`maxWorkflowSteps`, `maxToolCalls`, `maxDeliberationCalls`, `maxTokensTotal`, `maxDurationMs`).
- `requiredHooks.initialStep`: declared first step kind.
- `requiredHooks.canEmitGeneration()`: capability gate for generation emission.
- `requiredHooks.classifyNoGeneration(reasonCode)`: deterministic classification to disposition + termination reason.

Optional extensions:

- `reviewDecisionPrompt`
- `revisionPromptPrefix`
- `parseReviewDecision(text)`
- `metadata` for profile-local non-control annotations

Contract rule:

- optional extensions cannot override canonical no-generation classification,
  disposition, or termination-reason mapping.

## Blocked / No-Generation Behavior Matrix

| Condition                                              | Surface To Caller                               | Internal Termination | Required `terminationReason`   |
| ------------------------------------------------------ | ----------------------------------------------- | -------------------- | ------------------------------ |
| Policy blocks first `generate` transition              | Yes                                             | Yes                  | `transition_blocked_by_policy` |
| Profile disables generation (`enableGeneration=false`) | Yes                                             | Yes                  | `transition_blocked_by_policy` |
| Steps budget exhausted before first generation         | No (workflow ends silently inside orchestrator) | Yes                  | `budget_exhausted_steps`       |
| Token budget exhausted before first generation         | No (workflow ends silently inside orchestrator) | Yes                  | `budget_exhausted_tokens`      |
| Time budget exhausted before first generation          | No (workflow ends silently inside orchestrator) | Yes                  | `budget_exhausted_time`        |
| Executor/runtime failure before first generation       | Yes                                             | Yes                  | `executor_error_fail_open`     |

Notes:

- “Surface to caller” means the caller receives an explicit no-generation
  failure result (or equivalent error) instead of a generated assistant message.
- “Internal termination” means the workflow record always terminates with a
  canonical reason, even when not surfaced as a dedicated blocked UI state.

## Required No-Generation Reason Mapping

Canonical reason-code mapping is defined in:
`WORKFLOW_NO_GENERATION_HANDLING_MAP`
(`packages/backend/src/services/workflowProfileContract.ts`).

Required mapping:

- `blocked_by_policy_before_generate` -> `transition_blocked_by_policy`
- `generation_disabled_by_profile` -> `transition_blocked_by_policy`
- `budget_exhausted_steps_before_generate` -> `budget_exhausted_steps`
- `budget_exhausted_tokens_before_generate` -> `budget_exhausted_tokens`
- `budget_exhausted_time_before_generate` -> `budget_exhausted_time`
- `executor_error_before_generate` -> `executor_error_fail_open`

Disposition mapping:

- surfaced: policy-blocked, generation-disabled, executor-error
- internal-only: pre-generation budget exhaustion

## Provenance Requirements For No-Generation Outcomes

For all profiles, blocked-before-generation and no-generation outcomes must
produce a valid `WorkflowRecord` with:

- `workflowId`, `workflowName`
- `status='degraded'` (unless a future profile formally introduces a completed
  no-output mode with a new reason vocabulary)
- canonical `terminationReason` from the required map
- `stepCount` equal to `steps.length`
- `maxSteps`, `maxDurationMs`

When generation never occurred:

- `steps` may be empty (`stepCount=0`) when termination happens before the
  first executable step.
- if any step executed before no-generation termination, emitted steps must
  remain chronologically ordered with valid parent references.

Cross-profile invariants:

- no profile may emit ad-hoc termination reason strings.
- no profile may treat the same reason code as surfaced in one path and
  internal-only in another path.
- no profile may omit workflow provenance for no-generation outcomes.

## Compatibility Notes

Current `bounded-review` profile:

- compatible with this contract through policy/limits + review/revision
  extensions.
- current no-generation hotspot maps to
  `transition_blocked_by_policy` when generation is blocked before first
  draft emission.

Upcoming `generate-only` profile:

- should implement the same required hooks with
  `enableAssessment=false`, `enableRevision=false`.
- should reuse the same no-generation mapping and provenance invariants.
- should not introduce profile-specific blocked-state semantics.

## Follow-Up Implementation Issues

- [Profile Registry v1](https://github.com/footnote-ai/footnote/issues?q=is%3Aissue%20Profile%20Registry%20v1)
- [Generate-Only Profile](https://github.com/footnote-ai/footnote/issues?q=is%3Aissue%20Generate-Only%20Profile)
