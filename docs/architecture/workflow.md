# Workflows

A workflow is the step pattern Footnote uses to answer a request.

It decides whether the system generates once, runs a review pass, stops
because of policy or limits, and records metadata about what happened.

This page explains how mode, profile, planner, limits, and workflow metadata
fit together in the chat path today.

A chat request has to answer a few questions before the model returns
anything:

- how careful should this run be?
- should the answer be reviewed?
- what limits apply?
- what did the planner influence?
- what should the trace show afterward?

Footnote answers those questions through a small set of runtime layers:

1. The Execution Contract sets the run rules and limits.
2. The workflow mode chooses the kind of run.
3. The workflow profile chooses the step pattern.
4. The planner can suggest action details inside those limits.
5. Workflow metadata records what happened.

Keep those layers separate. Most workflow bugs start when one layer quietly
takes over another layer's job.

## Ownership boundaries

Workflow logic is spread across a few backend layers on purpose. Keep the
ownership split clear:

- Engine core owns transition legality, hard limits, workflow state, and
  canonical termination reasons.
- Workflow profile owns the step shape and step-specific semantics for one
  workflow kind.
- Adapters and callers own request assembly, runtime calls, metadata
  persistence, and route integration.

That means:

- the engine decides whether a step is legal
- the profile describes what kind of workflow it is
- the adapter connects that workflow to the real route and model calls

Adapters should not decide what step comes next or invent their own stop
reasons. Profiles should not bypass engine legality checks or hard limits.

## Runtime shape

The normal chat path starts with the Execution Contract. That contract decides
what behavior is allowed for the request.

After that, the backend resolves a workflow mode:

- `fast`
- `balanced`
- `grounded`

The mode maps to a workflow profile. The profile is the step pattern the
runtime uses.

Today there are two built-in profiles:

| Profile id       | Purpose                       | Main steps                     |
| ---------------- | ----------------------------- | ------------------------------ |
| `generate-only`  | direct single-pass generation | `generate`                     |
| `bounded-review` | reviewed message generation   | `generate -> assess -> revise` |

`fast` uses `generate-only`.

`balanced` and `grounded` both use `bounded-review`.

The difference between `balanced` and `grounded` is not the step pattern. The
difference is the contract preset, limits, and evidence posture selected for
the run.

## Modes

The mode ids are user-facing enough to appear in product copy, with normal
casing: `Fast mode`, `Balanced mode`, and `Grounded mode`.

The profile ids are internal: `generate-only` and `bounded-review`.

Do not use profile ids as the main labels under an answer. A user does not
need to know that `balanced` maps to `bounded-review` to understand that the
answer was reviewed.

| Mode       | Contract preset    | Workflow profile | Flow                   | Review | Evidence posture |
| ---------- | ------------------ | ---------------- | ---------------------- | ------ | ---------------- |
| `fast`     | `fast-direct`      | `generate-only`  | single-pass generation | no     | minimal          |
| `balanced` | `balanced`         | `bounded-review` | reviewed generation    | yes    | balanced         |
| `grounded` | `quality-grounded` | `bounded-review` | reviewed generation    | yes    | stricter         |

Grounded and reviewed are runtime labels. They describe the path Footnote
took, not a guarantee that the answer is true.

## Mode selection

Mode selection happens during initial routing in this order:

1. Use the requested mode when it is recognized.
2. Otherwise, if the Execution Contract provides a response mode, map it to
   the canonical workflow mode: `quality_grounded` maps to `grounded`, and
   `fast_direct` maps to `fast`.
3. Otherwise, fall back to `grounded`.

That fallback keeps the system available while still preferring the more
careful default.

These fallback steps happen only during initial routing. They are separate from
runtime mode escalation.

Mode escalation also lives in `resolveWorkflowRuntimeConfig`
(`packages/backend/src/services/workflowProfileRegistry.ts`). Keep it
centralized there: resolve the initial mode once, apply at most one
workflow-owned escalation request, and do not run recursive mode
re-evaluation. Do not scatter escalation routing across the orchestrator,
planner, UI, or adapters.

## Runtime flow

The current chat path looks like this:

1. `chatOrchestrator` receives and normalizes the request.
2. The Execution Contract sets the allowed behavior and limits.
3. The backend resolves workflow mode and profile.
4. Planner runs once in `chatOrchestrator` before workflow execution and generation.
5. Planner output goes through surface policy, capability policy, and tool
   policy.
6. `chatService` runs the workflow engine with the profile selected for the mode:
    - `fast` uses the `generate-only` profile (one generate step, no assess/revise)
    - `balanced` and `grounded` use the `bounded-review` profile (generate -> assess -> revise loop)
7. Response metadata records mode, planner influence, workflow lineage, cost,
   and trace or provenance fields.

Planner affects execution today, but planner timing still runs before the main
workflow-engine execution path.

Planner lineage can appear in workflow metadata as a `plan` step when that
metadata exists for the run. That is a lineage bridge, not a change in planner
authority.

So planner can appear in workflow lineage even though it still runs before the
main workflow execution path.

## Review loop

`generate-only` runs one `generate` step and stops.

`bounded-review` runs a bounded review path:

```text
generate -> assess -> revise
```

The `generate` step produces the current draft.

The `assess` step returns `reviewDecision` and `reviewReason`.

`reviewDecision` is either `finalize` or `revise`.

If the decision is `revise`, the `revise` step produces the next draft.

The loop stops when it reaches a final answer, hits a limit, or fails open.

A review result can request revision, but it does not bypass workflow policy or
engine limits.

## Planner

Planner helps decide how to carry out the request. It can suggest action
shape, search or tool details, capability profile, response posture, and
planner-facing explanation metadata.

Those suggestions stay inside backend policy. Planner cannot change the
Execution Contract, grant tools or steps, bypass policy, own mode or profile
selection, own safety, own provenance, or own final response behavior.

Planner information can appear in workflow metadata as a `plan` step when
available. That is lineage, not authority. Planner still runs before workflow
execution in the main chat path.

When metadata supports it, trace copy can say `Planned, then generated` or
`Planner fallback`. Avoid phrasing that makes planner sound like it owns the
workflow, especially `Planner-driven workflow`, `Planner-owned workflow`, or
`Workflow started with planning`.

The answer receipt should mention planner only when it changes the user-facing
story, such as planner fallback. Normal planner lineage belongs in the trace.

## Response metadata

Response metadata has a few related surfaces:

- `metadata.workflowMode.*` explains the routing choice
- `metadata.workflow` records workflow lineage
- `metadata.execution[]` records execution events, including planner influence
- TRACE or provenance fields describe answer behavior and trace presentation

`metadata.workflowMode` includes fields such as `modeId`, `selectedBy`,
`selectionReason`, `initial_mode`, `escalated_mode`, `escalation_reason`,
`requestedModeId`, `executionContractResponseMode`, and `behavior`.

Read those records together. They describe different parts of the run.

Planner influence is not workflow authority.

TRACE fields describe answer behavior, not workflow routing.

## Answer receipts

Footnote is starting to show more workflow information near answers and in
traces.

The answer surface should stay small. It can say what mode ran, whether review
ran, whether fallback happened, and whether a trace link is available. The
detailed step list belongs in the trace.

Receipt text should stay short:

- `Answered in Balanced mode`
- `Reviewed before final answer`
- `Review skipped`
- `Planner fallback`
- `Grounding evidence was not available`

Do not show raw workflow chains like `generate -> assess -> revise` under
every answer. That belongs in architecture docs or trace detail, not in the
normal reading path.

## Placement

Keep each kind of workflow information in one main place.

Answer footer:

- mode
- short review or fallback summary
- trace link

Trace page:

- step order
- planner lineage
- stop reasons
- technical detail that explains the run

Docs:

- internal profile names
- architecture terms
- runtime boundaries

Do not solve placement questions ad hoc in each ticket.

If the information mainly explains the run after the fact, it belongs in the
trace.

If it mainly helps the reader understand the answer at a glance, it can belong
in the footer.

## Review and fallback wording

A review label means a review step ran. It says nothing stronger than that.

Use words like `reviewed`, `revised`, `skipped`, and `fallback`. Do not use
`verified`.

Fallback should be visible in the trace. A fallback is not automatically a bad
result. Sometimes Footnote should return the best available answer instead of
hiding the response because one step failed.

But if review failed open, search was unavailable, or a limit stopped the
workflow, the trace should say so.

## Grounded mode wording

Grounded mode should describe evidence posture, not truth.

The UI can say that Grounded mode used available source signals, or that
grounding evidence was not available for a response. It can say that citations
were included.

Avoid stronger claims like `truth checked`, `guaranteed`, or `verified`.

Any grounded wording should be backed by metadata, such as citations, source
usage, search or tool result evidence, or an explicit evidence-unavailable
state.

The mode name alone is not evidence.

If the runtime did not retrieve sources, check citations, or record grounding
evidence, the UI should not imply that it did.

## Workflow profile contract

Executable workflow profiles satisfy a small contract defined in:

```text
packages/backend/src/services/workflowProfileContract.ts
```

The required profile fields are `profileId`, `profileVersion`, `displayName`,
`workflowName`, `policy`, `defaultLimits`, `requiredHooks.initialStep`,
`requiredHooks.canEmitGeneration()`, and
`requiredHooks.classifyNoGeneration(reasonCode)`.

The policy defines capability toggles such as `enablePlanning`,
`enableToolUse`, `enableReplanning`, `enableGeneration`, `enableAssessment`,
and `enableRevision`.

The default limits define hard caps such as `maxWorkflowSteps`, `maxToolCalls`,
`maxDeliberationCalls`, `maxTokensTotal`, and `maxDurationMs`.

Optional profile extensions can support review and revision behavior, but they
cannot override required no-generation classification, disposition, or
termination-reason mapping.

Mode chooses the kind of run. Profile chooses the step pattern. The engine
enforces legality and limits. Adapters connect the profile to runtime calls.

## Engine, profile, and adapter roles

Use this split when ownership is unclear:

| Concern             | Engine core                                                                                         | Workflow profile                                                             | Adapters and callers                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Step legality       | owns the canonical legality check before execution                                                  | declares intended flow and policy toggles                                    | supplies policy, but must not bypass legality checks                  |
| Limits              | owns hard-stop checks and stop-reason mapping                                                       | declares default budgets within the shared limits model                      | passes config and surfaces the final result                           |
| Workflow state      | owns step count, token totals, current step, and lineage progression                                | declares expected step shape                                                 | treats engine-produced workflow state as authoritative                |
| Step execution      | owns bounded-review concrete step execution today (`generate`, `assess`, `revise`) and step records | defines step-specific semantics such as review parsing                       | builds requests and calls runtimes or providers                       |
| Termination reasons | owns canonical termination reasons                                                                  | can request stop, but cannot invent new canonical reasons                    | persists and returns engine-assigned reasons unchanged                |
| Fail-open behavior  | owns degraded fail-open workflow behavior                                                           | can define recoverable profile behavior, but not canonical fail-open meaning | must not block the user response on telemetry or persistence failures |

If a workflow bug looks like "who decided that?", start with this table.

## Engine scope

The workflow engine mainly powers the reviewed chat path in:

```text
packages/backend/src/services/workflowEngine.ts
```

It handles transition checks, hard limits, bounded
`generate -> assess -> revise` execution, termination reasons, fail-open
handling, `WorkflowRecord` output, and `StepRecord` output.

The shared workflow vocabulary includes `plan`, `tool`, `generate`, `assess`,
`revise`, and `finalize`.

### Current ownership

| Component                        | Owner   | Notes                                                                                               |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `workflowEngine`                 | Core    | Owns bounded-review steps (`generate`, `assess`, `revise`) and injected context-step execution      |
| `chatOrchestrator`               | Core    | Owns planner execution (pre-workflow), mode/profile/contract resolution, tool intent construction   |
| `chatService`                    | Core    | Invokes workflowEngine, handles context-step short-circuit responses (clarification, failure)       |
| `toolRegistryContextStepAdapter` | Adapter | Keeps workflowEngine provider-neutral while mapping tool-registry execution into context-step shape |

### Context-step executor pattern

The workflow engine can execute context integrations such as
`weather_forecast` before generation through an injected executor. This keeps
the engine provider-neutral while allowing tools to inject context into the
generation prompt.

The pattern works like this:

1. `chatOrchestrator` builds a `ContextStepRequest` describing the requested
   integration and a `ContextStepExecutor` function to execute it
2. `chatService` passes these to `runBoundedReviewWorkflow`
3. `workflowEngine` executes the context step before the `generate` step:
    - On success: context messages are injected into the generation prompt
    - On clarification needed: workflow terminates with `goal_satisfied` and
      returns a user-facing clarification response
    - On failure: workflow continues fail-open without context (no-fabrication
      guardrail preserved)

The adapter `toolRegistryContextStepAdapter.ts` implements this pattern for
`weather_forecast`. Additional tools would follow the same structure.

### Planner execution

Planner runs before workflow execution in `chatOrchestrator`. Planner
output goes through surface policy, capability policy, and tool policy before
reaching the chat service.

Planner lineage can appear in workflow metadata as a `plan` step when that
metadata exists for the run. That is a lineage bridge, not a change in planner
authority. Planner timing and execution are still not workflow-engine-owned.

In the current split:

- planner timing lives in `chatOrchestrator` before workflow execution
- weather_forecast execution uses the workflow context-step path
- web_search unchanged (not migrated to context-step)
- workflow metadata can include bridged planner lineage

## Step records

Each `StepRecord` includes an outcome with `status`, `summary`, `artifacts`,
`signals`, and optional `recommendations`.

`signals` are machine-readable control indicators used by transition logic.
They are not generic telemetry.

For bounded-review `assess` steps, use `reviewDecision` and `reviewReason`.

`recommendations` are advisory only. They never override backend legality
checks.

Step records should stay serializable, bounded, and safe to expose in trace or
provenance contexts. Do not dump raw prompts, raw model output, full planner
payloads, or unbounded tool results into step records.

## Limits

Workflow limits are backend-enforced stops, not model suggestions.

`WorkflowPolicy` defines legal transitions and capability toggles.

`ExecutionLimits` defines hard caps: `maxWorkflowSteps`, `maxToolCalls`,
`maxDeliberationCalls`, `maxTokensTotal`, and `maxDurationMs`.

Model output can recommend transitions only where policy allows.

If a limit stops a run, the workflow record should say so.

Profiles may narrow budgets, but they may not suppress hard-limit enforcement.
Adapters may pass configured limits, but they do not assign exhausted-limit
reason codes.

## No-generation behavior

No-generation outcomes still need valid workflow metadata.

| Condition                                              | Surface to caller | Internal termination | Required `terminationReason`   |
| ------------------------------------------------------ | ----------------- | -------------------- | ------------------------------ |
| Policy blocks first `generate` transition              | yes               | yes                  | `transition_blocked_by_policy` |
| Profile disables generation (`enableGeneration=false`) | yes               | yes                  | `transition_blocked_by_policy` |
| Step budget exhausted before first generation          | no                | yes                  | `budget_exhausted_steps`       |
| Token budget exhausted before first generation         | no                | yes                  | `budget_exhausted_tokens`      |
| Time budget exhausted before first generation          | no                | yes                  | `budget_exhausted_time`        |
| Executor or runtime failure before first generation    | yes               | yes                  | `executor_error_fail_open`     |

`Surface to caller` means the caller receives an explicit no-generation result
or equivalent error instead of a generated assistant message.

`Internal termination` means the workflow record still terminates with a reason
code, even when there is no dedicated blocked UI state.

The mapping lives in `WORKFLOW_NO_GENERATION_HANDLING_MAP`:

```text
packages/backend/src/services/workflowProfileContract.ts
```

Required reason mapping:

| Reason code                               | Termination reason             |
| ----------------------------------------- | ------------------------------ |
| `blocked_by_policy_before_generate`       | `transition_blocked_by_policy` |
| `generation_disabled_by_profile`          | `transition_blocked_by_policy` |
| `budget_exhausted_steps_before_generate`  | `budget_exhausted_steps`       |
| `budget_exhausted_tokens_before_generate` | `budget_exhausted_tokens`      |
| `budget_exhausted_time_before_generate`   | `budget_exhausted_time`        |
| `executor_error_before_generate`          | `executor_error_fail_open`     |

Policy-blocked, generation-disabled, and executor-error outcomes are surfaced.

Pre-generation budget exhaustion is internal-only.

Keep these rules stable:

- blocked or no-generation outcomes must be explicit
- callers must not fabricate generated content when no generation happened
- profiles must not emit ad hoc termination strings
- the same stop reason should not be surfaced in one path and hidden in
  another without a documented rule

## Workflow metadata

For all profiles, blocked-before-generation and no-generation outcomes must
produce a valid `WorkflowRecord`.

That record should include `workflowId`, `workflowName`, `status='degraded'`,
`terminationReason`, `stepCount`, `maxSteps`, and `maxDurationMs`.

When generation never occurred:

- `steps` may be empty when termination happens before the first executable
  step
- if any step executed before termination, emitted steps must stay
  chronologically ordered with valid parent references

Profiles must not emit ad-hoc termination reason strings, treat the same
reason as surfaced in one path and internal-only in another, or omit workflow
provenance for no-generation outcomes.

## Stable rules

These workflow rules should stay true even as profiles expand:

- no step runs unless policy and legality allow it
- engine checks limits before bounded step execution
- engine assigns canonical limit-exhaustion reasons
- profile recommendations are advisory, not authority
- mode chooses the kind of run first
- profile chooses the executable step shape second
- adapters wire the workflow into the real app, but do not own workflow
  control-plane decisions

## Future work

Future workflow work may add planner timing owned by the workflow engine,
first-class tool steps, replanning, broader workflow diagrams, and user-facing
workflow controls.

TODO(workflow-search-profile-split): Define and implement explicit split-model
execution for retrieval vs final generation. Current routing resolves one
selected response profile and may reroute that profile when search capability
is required, which prevents "search on profile A, generate on profile B" in
one request path.

Recommended design boundary for that work:

- retrieval profile selection remains policy-governed and deterministic
- generation profile selection remains request or planner governed by routing strategy
- retrieval evidence joins runtime context and provenance before final generation
- trace and execution metadata report both retrieval and generation profile lineage

Keep UI copy and docs tied to what exists now.

For now, keep workflow-facing UI close to current metadata: mode, review or
fallback summary, grounding evidence availability, trace links, and
backend-owned usage data when present.

## Runtime boundaries

The Execution Contract sets the run rules. Workflow records the step pattern
used for the run. The orchestrator coordinates the request and response.
Planner suggests how to handle the request. Adapters run provider-specific
work. Trace and provenance explain what happened.

The web UI should render backend-owned facts. It should not infer new workflow
meanings from raw metadata, invent budget numbers, or hide fallback to make a
run look cleaner.

## Related docs

- [Context Integrations](./context-integrations/README.md)
- [Answer Posture And Control Influence](./answer-posture-and-control-influence.md)
- [Workflow Rollout Status](../status/workflow-engine-rollout-status.md)
