# Workflow Engine And Provenance

## Purpose

Explain the current workflow engine and the metadata it emits.

This doc covers what is implemented now, not the full plan.
Read [Workflow Runtime](./workflow-runtime.md) first if you need the
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
- [Workflow Runtime](./workflow-runtime.md)
- [Response Metadata](./response-metadata.md)
- [Workflow Engine Rollout Status](../status/2026-04-workflow-engine-rollout-status.md)
