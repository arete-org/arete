# Workflow Profiles V1 RFC: Engine Core vs Profile Semantics

## Status

- Draft date: 2026-04-03
- Scope: Architecture boundary contract for workflow execution
- Applies to: `packages/backend/src/services/workflowEngine.ts` and caller adapters

This RFC is historical design context for the workflow-engine rollout.
For the current first-read explanation, use:

- [Workflow Runtime](./workflow-runtime.md)
- [Workflow Language](./workflow-language.md)

## Why This Exists

Workflow logic can spread across several files and layers.
When that happens, it gets harder to tell who is allowed to choose the next
step, who enforces limits, and who records the reason a workflow stopped.

This RFC defines those ownership boundaries so new workflow profiles do not
drift into ad hoc control logic.

Think of the system in three layers:

- engine core (`workflowEngine`)
- workflow profile semantics
- caller/executor adapters

Workflow mode routing sits one level above this document. Mode chooses the kind
of run first, then profile semantics choose the executable step shape.

The engine runs the workflow safely.
The profile describes what kind of workflow it is.
The adapter connects that workflow to the real route, model, and persistence
code.

## Non-Goals

- Implementing new workflow capabilities.
- Tool graph orchestration.
- Broad contract/schema rewrites.

## The Three Parts

- Engine core: shared workflow control code.
  It checks legal transitions, applies hard limits, tracks state, and assigns
  termination reasons.
- Profile semantics: the rules for one kind of workflow.
  A profile says what steps that workflow can take and how to interpret the
  results of those steps.
- Caller/executor adapters: the route/runtime integration layer.
  Adapters build requests, call providers, assemble metadata, and persist
  traces.

## What A Workflow Profile Is

A workflow profile is a named workflow shape.

It:

- declares the intended step sequence,
- provides step-specific prompts, parsing, and output interpretation when needed,
- cannot override engine legality checks, hard limits, or termination rules,
- is selected explicitly by adapters or configuration, not inferred from side effects or request shape.

## Who Owns What

Questions about whether a step is allowed or whether a workflow should stop
belong to the engine.

Use the table below as the primary ownership reference.
If ownership is unclear, start there.

| Concern                       | Engine Core (`workflowEngine`)                                                                         | Profile Semantics                                                                                                                  | Caller/Executor Adapters (`chatService`, route/runtime adapters)                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Transition legality check     | Owns canonical transition legality function and policy enforcement gate before step execution.         | Declares intended profile flow and policy toggles used for that flow.                                                              | Supplies profile policy to engine; must not bypass engine legality checks.                     |
| Limit enforcement             | Owns hard-stop evaluation and limit-to-termination mapping.                                            | Declares profile-configured budgets (for example iterations, duration) within engine limits model.                                 | Supplies configured limits from runtime config; surfaces final termination reason.             |
| State progression             | Owns workflow state mutation (step count, tool calls, deliberation calls, token totals, current step). | Declares which step kinds are expected next for the profile.                                                                       | Must treat engine state/lineage output as authoritative.                                       |
| Step execution body           | Owns orchestration envelope and step recording helpers.                                                | Defines step semantics, including any profile-specific prompts, parse rules, and output interpretation.                            | Provides executors (provider/runtime transport) and request assembly for each step invocation. |
| Termination reason assignment | Owns canonical reason assignment for policy blocks and exhausted limits.                               | Can request profile stop (for example model says finalize), but cannot invent non-canonical reason codes.                          | Must persist/report engine-assigned reason unchanged in metadata.                              |
| Fail-open behavior            | Owns canonical `executor_error_fail_open` pathway and degraded status semantics.                       | May define when executor failures are recoverable inside that profile; cannot redefine canonical fail-open status/reason behavior. | Must not block response solely due to telemetry/persistence failures.                          |
| Provenance structure          | Owns `WorkflowRecord` + `StepRecord` assembly invariants.                                              | Adds profile-specific step signals/recommendations within schema and must not weaken lineage invariants.                           | Persists and returns metadata; does not reshape authoritative lineage fields.                  |

## Two Example Profiles

### Anchor Profile A: `generate-only`

Intent: run one `generate` step, then stop.

Expected lifecycle:

1. `generate` executes once if legal and within limits.
2. The workflow stops immediately after generation.
3. Termination reason:

- `goal_satisfied` if generation succeeds.
    - `transition_blocked_by_policy` if `generate` is disabled.
    - a budget/limit reason if a pre-step limit check is already exhausted.
    - `executor_error_fail_open` if the runtime call fails and the caller returns a degraded fail-open result.

Ownership notes:

- Engine owns legality + limits + termination mapping.
- Profile only constrains that no `assess`/`revise` step is entered.
- Adapter owns request build and response metadata persistence.

### Anchor Profile B: `bounded-review`

Intent: run `generate -> assess -> revise` in a bounded loop, then stop for a
clear reason.

Expected lifecycle:

1. Initial `generate` runs once (attempt 1).
2. For each iteration (up to profile max):

- `assess` runs and returns a profile decision: `finalize` or `revise`.
  The assess `StepRecord.outcome.signals` is the canonical machine-readable
  seam for this decision: `reviewDecision` + `reviewReason`.
    - If `finalize`, terminate with `goal_satisfied`.
    - If `revise`, run `revise`, then continue loop.

3. Stop when:

- profile decision finalizes,
    - max iteration-derived step budget is exhausted,
    - duration/deliberation/other hard limits are exhausted,
    - transition becomes illegal under policy,
    - executor error triggers fail-open.

Ownership notes:

- Engine owns legality checks before each step and all exhausted-limit reason assignment.
- Profile owns review-decision schema, parsing, and revision prompt strategy.
- Adapter owns runtime/model defaults, usage accounting calls, and metadata assembly.

## Rules That Should Stay True

These rules are intended to prevent state, provenance, and control-flow drift.

### Legality Invariants

- No step may execute unless `isTransitionAllowed(currentStepKind, nextStepKind, policy)` returns `true`.
- Profile recommendations are advisory and cannot bypass legality gates.
- Adapters must not perform their own step transitions outside the engine.

### Limits Invariants

- Engine evaluates limits before each bounded step execution.
- The engine maps exhausted limits to termination reasons.
- Profile config may narrow budgets, but cannot suppress hard-limit enforcement.
- Adapters may pass budgets/config, but they do not choose exhausted-limit reason codes.

### Termination Reason Invariants

- Each workflow run gets exactly one canonical termination reason.
- Only the engine assigns limit-exhaustion reasons.
- `transition_blocked_by_policy` is assigned only when legality gate blocks an attempted transition.
- `goal_satisfied` is assigned only when profile objective is reached under legal execution.
- `executor_error_fail_open` is assigned only when a runtime/executor failure returns degraded fail-open output on purpose.

### Blocked/No-Generation Invariants

- Profiles may terminate before any generation step succeeds.
- Adapters must not fabricate generated content or synthetic provenance when no generation occurred.
- Blocked/no-generation outcomes must be surfaced explicitly, not returned as fake success responses.

## How This Should Scale

### `plan-and-generate`

- Profile semantics add optional `plan` pre-step and optional replan loop under explicit policy toggle.
- Engine core should remain unchanged except consuming declared step sequence and any minimally required shared step-kind support.
- New profile must reuse existing legality/limits/termination invariants.
- Adapter impact: pass plan-capable policy and expose plan artifacts/signals in workflow metadata.

### `bounded tool-assisted`

- Profile semantics may introduce bounded `tool` step between `plan/generate/assess` depending on policy.
- Engine retains ownership of `maxToolCalls` enforcement and limit-to-reason mapping.
- Profile defines when tool use is attempted and what tool outcome signals gate next transitions.
- Adapter impact: implement tool runtime invocation and normalize tool execution results without changing canonical termination assignment.

## Rules To Keep Stable

- Engine core owns legality checks and hard stop conditions.
- Profiles own workflow semantics, not control-plane authority.
- Adapters are responsible for wiring the workflow to the real app: building requests, calling providers, and saving metadata. They should not decide what step comes next or why the workflow stops.
- Canonical termination reasons stay contract-defined and backend-assigned.

## Backend Reviewer Sign-Off

| Role             | Reviewer | State     | Date  | Notes                                             |
| ---------------- | -------- | --------- | ----- | ------------------------------------------------- |
| Backend reviewer | `TBD`    | `pending` | `TBD` | Required before merge/finalization of RFC status. |
