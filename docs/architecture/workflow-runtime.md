# Workflow Mode Routing

## Purpose

A workflow mode is the routing choice for one chat request.

This is the main doc for workflow and planner behavior today.
Read this before the profile contract, rollout notes, or RFC material.

When a chat request comes in, Footnote has to decide how careful the run
should be before it starts generating. Some requests can take the fast path.
Others should use the reviewed path, with stricter evidence and revision rules.

This doc explains that routing layer.

The split is simple. The Execution Contract sets the limits for the run.
Workflow mode chooses the run type. Workflow profile chooses the step pattern.
Planner can suggest action details inside those limits. Workflow lineage shows
what actually happened.

## Runtime Flow

The normal chat path starts with the Execution Contract. That contract decides
the allowed behavior and limits for the request.

After that, the backend resolves a workflow mode: `fast`, `balanced`, or
`grounded`. The mode maps to a workflow profile, which is the step pattern the
runtime will use. For example, `fast` maps to `generate-only`, while
`balanced` and `grounded` both use `bounded-review`.

Planner runs once in `chatOrchestrator` before generation. Its output still
goes through surface policy, capability policy, and tool policy. Then
`chatService` runs either direct generation or the bounded review loop.

Response metadata records the selected mode, planner influence, and workflow
lineage.

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
`generate -> assess -> revise` in a bounded loop. That is why the reviewed
path matters here: it gives the runtime one bounded chance to assess the draft
and revise it before stopping.

The assess step emits two machine-readable fields: `reviewDecision`
(`finalize` or `revise`) and `reviewReason`. A review result can request a
revision, but it does not bypass workflow policy or engine limits.

## Planner Boundary

Planner helps decide how to carry out the request. It can suggest search or
tool details, choose an action shape, and recommend a capability profile.

Those suggestions stay inside backend policy. Planner cannot change the
Execution Contract, grant extra tools or steps, bypass policy, or become the
final authority on mode, profile, safety, or provenance.

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

`metadata.workflowMode.*` explains the routing choice.
`metadata.execution[]` planner entries explain planner influence.
`metadata.workflow` records workflow lineage.
TRACE fields describe answer behavior, not workflow routing.

The `workflowMode` object includes `modeId`, `selectedBy`,
`selectionReason`, `initial_mode`, optional `escalated_mode`, optional
`escalation_reason`, optional `requestedModeId`, optional
`executionContractResponseMode`, and `behavior`.

# Workflow Profile Contract

## Purpose

Define the contract that executable workflow profiles must satisfy.

This is a contract doc, not the best first explanation of the current runtime
flow.
Read [Workflow Runtime](./workflow-runtime.md) first if you are new.

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
