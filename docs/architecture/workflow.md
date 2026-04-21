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

# Workflow Profile Contract

## Purpose

Define the contract that executable workflow profiles must satisfy.

This is a contract doc, not the best first explanation of the current runtime
flow.
Read [Workflow](./workflow.md) first if you are new.

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

# Workflow wording

We're starting to show more workflow information near answers and in traces.
This note is here so that work uses the same language.

The UI should describe what happened during a run. It should not make the run
sound more certain, more complete, or more automated than it was.

Footnote currently exposes three public modes: `fast`, `balanced`, and
`grounded`. In product copy, use `Fast mode`, `Balanced mode`, and
`Grounded mode`.

The internal profiles are `generate-only` and `bounded-review`. Those names are
useful in code and architecture docs, but they should not appear as the main
labels under an answer. A user does not need to know that `balanced` maps to
`bounded-review` to understand that the answer was reviewed.

Fast mode is the single-pass path. Balanced mode can run review before
returning the answer. Grounded mode uses the stricter evidence posture
available to the current runtime.

That last part needs careful wording. Grounded does not mean verified. It does
not mean guaranteed true. If source evidence was not available for a run, the
trace should say that instead of letting the mode name carry more weight than
it earned.

## Answer receipts

The answer footer should stay small. It can say what mode ran, whether review
ran, whether a fallback happened, and whether a trace link is available. The
detailed step list belongs in the trace.

Good receipt text is short:

- `Answered in Balanced mode`
- `Reviewed before final answer`
- `Review skipped`
- `Planner fallback`
- `Grounding evidence was not available`

Do not show raw workflow chains like `generate -> assess -> revise` under every
answer. That belongs in architecture docs or trace detail, not in the normal
reading path.

## Placement

Keep each kind of workflow information in one main place.

- Answer footer: mode, short review or fallback summary, trace link
- Trace page: step order, planner lineage, stop reasons, and technical detail
  that explains the run
- Docs: internal profile names, architecture terms, and runtime boundaries

Do not solve placement questions ad hoc in each ticket. If the information is
mainly explaining the run after the fact, it belongs in the trace. If it is
mainly helping the reader understand the answer at a glance, it can belong in
the footer.

## Planner wording

Planner information can appear in workflow metadata as a `plan` step. When a
run has that metadata, the trace can show it.

Keep the wording narrow. `Planned, then generated` is fine when the metadata
supports it. `Planner fallback` is fine when fallback happened. Avoid phrases
that make the planner sound like it owns the workflow.

The answer receipt should mention planner only when it changes the user-facing
story, such as planner fallback. Normal planner lineage belongs in the trace.

Planner still runs before workflow execution in the main chat path today. It
can shape the response path, but it does not own policy, safety, mode
selection, provenance, or final response behavior.

## Review and fallback

A review label means a review step ran. It does not mean the answer was
verified.

Use words like `reviewed`, `revised`, `skipped`, and `fallback`. Do not use
`verified`.

Fallback should be visible in the trace. A fallback is not automatically a bad
result; sometimes Footnote should return the best available answer instead of
hiding everything because one step failed. But if review failed open, search
was unavailable, or a limit stopped the workflow, the trace should say so.

## Grounded mode

Grounded mode should describe evidence posture, not truth.

The UI can say that grounded mode used available source signals, or that
grounding evidence was not available for a response. It can say that citations
were included. It should not say the answer was truth checked, guaranteed, or
verified.

Any grounded wording should be backed by metadata, such as citations, source
usage, search or tool result evidence, or an explicit evidence-unavailable
state.

The mode name alone is not evidence. If the runtime did not retrieve sources,
check citations, or record grounding evidence, the UI should not imply that it
did.

## Current implementation phase

For the next few workflow-facing tickets, stay close to current runtime
behavior:

- a short receipt near the answer
- clearer fallback and stop reasons in the trace
- review labels that do not overclaim
- grounded-mode wording that says when evidence was or was not available
- budget and usage visibility when backend metadata supports it

Leave bigger workflow controls for later. That includes replanning, generic
tool steps and broad workflow diagrams. Those may become useful, but they
should not be described as current behavior.

## Boundaries

The Execution Contract sets the run rules. Workflow records the step pattern
used for the run. The orchestrator coordinates the request and response. The
planner suggests how to handle the request. Adapters run provider-specific work.
Trace and provenance explain what happened.

The web UI should render backend-owned facts. It should not guess new workflow
meanings from raw metadata, invent budget numbers, or hide fallback because it
makes the run look less clean.

## Related docs

- [Execution Contract Authority Map](./execution-contract-authority-map.md)
- [Workflow](./workflow.md)
- [Response Metadata](./response-metadata.md)
- [Workflow Engine Rollout Status](../status/2026-04-workflow-engine-rollout-status.md)

# Workflow Engine And Provenance

## Purpose

Explain the current workflow engine and the metadata it emits.

This doc covers what is implemented now, not the full plan.
Read [Workflow](./workflow.md) first if you need the
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

## Steps

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

## Metadata

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

For rollout history, see
`docs/status/2026-04-workflow-engine-rollout-status.md`.
