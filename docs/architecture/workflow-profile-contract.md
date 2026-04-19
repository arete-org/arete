# Workflow Profile Contract

## Purpose

Define the contract that executable workflow profiles must satisfy.

This is a contract doc, not the best first explanation of the current runtime
flow.
Read [Workflow Mode Routing](./workflow-mode-routing.md) first if you are new.

## Scope

This document covers the profile contract, no-generation behavior, required
termination-reason mapping, workflow metadata requirements, and compatibility
rules for `bounded-review` and `generate-only`.

It does not cover profile registry runtime implementation, plan-and-generate
or tool-assisted profiles, or blocked-state UI design.

## Built-In Profiles

Current chat runtime uses two built-in profiles:

| Profile id       | Current purpose              | Main steps                     |
| ---------------- | ---------------------------- | ------------------------------ |
| `generate-only`  | direct single-pass execution | `generate`                     |
| `bounded-review` | reviewed message generation  | `generate -> assess -> revise` |

Modes choose between these profiles. Profiles do not become a second policy
authority.

## Contract Shape

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

- optional extensions cannot override required no-generation classification,
  disposition, or termination-reason mapping.

Mode chooses the kind of run. Profile chooses the step pattern. The engine
enforces legality and limits. Adapters connect the profile to runtime calls.

## No-Generation Behavior

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
  reason code, even when not surfaced as a dedicated blocked UI state.

## Reason Mapping

Reason-code mapping is defined in:
`WORKFLOW_NO_GENERATION_HANDLING_MAP`
(`packages/backend/src/services/workflowProfileContract.ts`).

The required mapping is:
`blocked_by_policy_before_generate` -> `transition_blocked_by_policy`,
`generation_disabled_by_profile` -> `transition_blocked_by_policy`,
`budget_exhausted_steps_before_generate` -> `budget_exhausted_steps`,
`budget_exhausted_tokens_before_generate` -> `budget_exhausted_tokens`,
`budget_exhausted_time_before_generate` -> `budget_exhausted_time`,
and `executor_error_before_generate` -> `executor_error_fail_open`.

The disposition mapping is:
policy-blocked, generation-disabled, and executor-error are surfaced.
Pre-generation budget exhaustion is internal-only.

## Metadata Requirements

For all profiles, blocked-before-generation and no-generation outcomes must
produce a valid `WorkflowRecord` with `workflowId`, `workflowName`,
`status='degraded'`, `terminationReason` from the required map, `stepCount`
equal to `steps.length`, `maxSteps`, and `maxDurationMs`. A future profile may
introduce a completed no-output mode, but only with a new reason vocabulary.

When generation never occurred:

- `steps` may be empty (`stepCount=0`) when termination happens before the
  first executable step.
- if any step executed before no-generation termination, emitted steps must
  remain chronologically ordered with valid parent references.

Across profiles, no profile may emit ad-hoc termination reason strings, treat
the same reason code as surfaced in one path and internal-only in another, or
omit workflow provenance for no-generation outcomes.

## Compatibility Rules

Current `bounded-review` profile is compatible with this contract through
policy, limits, and review/revision extensions. Its current no-generation
hotspot maps to `transition_blocked_by_policy` when generation is blocked
before the first draft.

Current `generate-only` profile uses the same required hooks with
`enableAssessment=false` and `enableRevision=false`. It reuses the same
no-generation mapping and metadata rules and does not introduce
profile-specific blocked-state semantics.
