# Workflows

A workflow is the path Footnote uses to answer a chat request. It covers the
selected preset, planning, optional context, generation, review, fallback
behavior, and the metadata saved for trace and provenance.

The current chat path uses the reviewed workflow shape for both `balanced` and
`grounded`. The two presets share the same basic step pattern and differ in
contract preset, limits, model routing, and evidence posture.

## How a chat request runs

The normal chat path starts in `chatOrchestrator` and then moves through the
backend workflow runtime.

1. `chatOrchestrator` receives and normalizes the request.
2. The Execution Contract sets the allowed behavior and limits.
3. The backend resolves the workflow preset and runtime config.
4. `chatOrchestrator` provides the planner and context-step dependencies used
   during workflow execution.
5. `chatService` runs `workflowEngine` with the reviewed workflow shape.
6. Response metadata records the preset outcome, planner influence, workflow
   lineage, cost, trace fields, and provenance fields.

The main runtime pieces are:

- the Execution Contract, which sets the run rules and limits
- the preset, which selects the run posture
- the workflow shape, which defines the step pattern
- the planner, which can suggest how to handle the request within the run rules
- workflow metadata, which records what happened

Workflow logic is split across backend layers:

- Engine core handles transition checks, hard limits, workflow state, and
  termination reasons.
- Workflow profiles describe the step shape and step-specific behavior for one
  workflow kind.
- Adapters and callers assemble requests, call runtimes or providers, persist
  metadata, and connect workflow results to routes.

The engine is the source for step legality and workflow lineage. Profiles
describe the intended workflow. Adapters connect that workflow to the app.

## Presets and workflow shape

The backend currently resolves two presets:

- `balanced`
- `grounded`

Preset ids are user-facing enough to appear in product copy with normal casing:
`Balanced` and `Grounded`. Internal profile ids are not useful as primary labels
under an answer.

Both presets use the reviewed workflow shape:

| Workflow shape | Purpose                     | Main steps                                           |
| -------------- | --------------------------- | ---------------------------------------------------- |
| `reviewed`     | reviewed message generation | `generate -> assess -> planner re-entry -> generate` |

Preset details:

| Preset     | Contract preset    | Workflow shape | Flow                | Review | Evidence posture |
| ---------- | ------------------ | -------------- | ------------------- | ------ | ---------------- |
| `balanced` | `balanced`         | `reviewed`     | reviewed generation | yes    | balanced         |
| `grounded` | `quality-grounded` | `reviewed`     | reviewed generation | yes    | stricter         |

`Grounded` and `reviewed` describe the path Footnote took. They are not claims
that the answer is true.

Preset selection happens during initial routing:

1. Use the requested mode when it is recognized.
2. If the Execution Contract provides a response mode, map it to the preset:
   `quality_grounded` maps to `grounded`, and `fast_direct` maps to `balanced`.
3. If no mode is available, use `grounded`.

That fallback keeps the system available while preferring the more careful
default. These fallback steps happen during initial routing only. Runtime preset
escalation is handled separately.

Preset escalation lives in `resolveWorkflowRuntimeConfig`:

```text
packages/backend/src/services/workflowProfileRegistry.ts
```

That function resolves the initial mode once, then applies at most one
workflow-requested escalation. Recursive mode re-evaluation is not part of the
current path.

## Planning, context, and review

Workflow execution begins with the planner step. Planner timing and plan
lineage come from workflow execution, so trace records can show that planning
happened before generation.

`chatOrchestrator` provides two planner dependencies:

- `PlannerStepExecutor`, which calls the planner during the `plan` step
- `PlanContinuationBuilder`, which applies backend policy and builds the next
  workflow action

`PlanContinuationBuilder` applies planner output through
`PlannerResultApplier`, `classifyPlanContinuation`, and
`assemblePlanGenerationInput`. It chooses either `terminal_action` or
`continue_message`.

Planner output is guidance for the run. It can suggest action shape, search or
tool details, capability profile, response posture, and planner-facing
explanation metadata. The selected mode, profile, Execution Contract, limits,
safety behavior, provenance behavior, and final response behavior still come
from backend policy and runtime config.

Planner information appears in workflow metadata as a `plan` step. Trace copy
can say `Planned, then generated` or `Planner fallback` when metadata supports
that wording. The answer receipt usually mentions planner only when it changes
the user-facing story, such as planner fallback.

### Context steps

Context integrations run before generation through injected executors. Examples
include `weather_forecast`, `web_search`, `file_scan`, `trustgraph`, and
`reverse_image_search`.

The pattern is:

1. `chatOrchestrator` builds a `ContextStepRequest` for the requested
   integration and provides a `ContextStepExecutor`.
2. `chatService` passes those values to `runBoundedReviewWorkflow`.
3. `workflowEngine` executes the context step before `generate`.

Context-step outcomes:

- On success, context messages are injected into the generation prompt.
- On clarification needed, the workflow terminates with `goal_satisfied` and
  returns a user-facing clarification response.
- On failure, the workflow continues fail-open without injected context. The
  no-fabrication guardrail still applies.

This keeps the engine provider-neutral while still letting integrations add
bounded context to generation.

### Review loop

The reviewed workflow runs this bounded path:

```text
generate -> assess(refinementRequested?) -> planner re-entry(guidance) -> generate(refinementApplied?) -> assess(finalize)
```

The `generate` step produces the current draft. The `assess` step returns
`reviewDecision` and `reviewReason`.

`reviewDecision` is either `finalize` or `revise`. When the decision is
`revise`, `assess` may also emit `revisionInstruction`. `reviewReason` explains
why revision is needed. `revisionInstruction` gives concrete guidance for the
follow-up refinement `generate` step.

`revisionInstruction` is revise-only and is not emitted for `finalize`.

Assess may also emit TRACE alignment outputs:

- `traceAlignment`: `aligned` or `misaligned`
- `traceAlignmentReason`: short reason when `traceAlignment` is `misaligned`
- flattened final posture axes, such as `finalTemperamentTightness`

These assess outputs are used for lineage and metadata finalization. They stay
inside workflow policy and limits.

If the decision is `revise`, the engine may run planner re-entry and then a
follow-up `generate` step for refinement.

During revision generation only, assess hints can reorder the resolved generate
chain before execution:

- logic or grounding hints prefer an OpenAI-first lane
- style hints prefer an Ollama-first lane
- cost hints prefer cheaper candidates while preserving safe ordering
- when hints conflict, logic or grounding takes priority over style

This hint routing is internal and does not add required public API schema
fields.

The loop stops when it reaches a final answer, hits a limit, or fails open.

## Model routing

Model routing is resolved per workflow step. Defaults live in:

```text
packages/backend/src/config/model-profiles.defaults.yaml
```

Each mode resolves independent chains for `planner`, `generate`, and `assess`.
Chain entries can be direct profile ids or `chooseOne` pools. `chooseOne`
selection is deterministic for the request seed and step, so the choice is
reproducible while still spreading traffic across the pool.

Current default routing intent:

- `balanced` generate favors Ollama first, then OpenAI fallback
- `grounded` generate favors OpenAI first, then Ollama fallback
- `planner` and `assess` favor `openai-json-optimized` first in both modes

Routing is fail-open where possible:

- invalid chain entries are skipped with warnings
- empty chains fall back to safe backend defaults
- transient provider or upstream failures advance to the next chain entry
- non-transient errors stop chain advancement for that step

Execution metadata and step signals record selected profile lineage, fallback
attempts, and routing reason codes for trace inspection.

## What gets recorded

Workflow output is spread across a few metadata surfaces:

- `metadata.workflow` records workflow lineage
- `metadata.execution[]` records execution events, including planner influence
- TRACE or provenance fields describe answer behavior and trace presentation

Those records describe different parts of the same run. Planner influence is
recorded as lineage. TRACE fields describe how the answer was produced and
presented, not why a routing chain was selected.

### Step records

Each `StepRecord` includes an outcome with `status`, `summary`, `artifacts`,
`signals`, and optional `recommendations`.

`signals` are machine-readable control indicators used by transition logic.
They are not general telemetry.

For `assess` steps, use `reviewDecision` and `reviewReason`. When
`reviewDecision` is `revise`, `signals` may also include
`revisionInstruction`. Assess signals may also include TRACE alignment and
flattened final posture axes.

Example assess signals:

```json
{
    "reviewDecision": "finalize",
    "reviewReason": "Draft is complete.",
    "traceAlignment": "aligned"
}
```

```json
{
    "reviewDecision": "revise",
    "reviewReason": "Tone is too stiff.",
    "revisionInstruction": "Use simpler, more natural wording.",
    "traceAlignment": "misaligned",
    "traceAlignmentReason": "Delivered posture was broader than target.",
    "finalTemperamentTightness": 5,
    "finalTemperamentAttribution": 4
}
```

`recommendations` are guidance only. Backend legality checks still decide which
transitions can run.

Step records need to stay serializable, bounded, and safe to expose in trace or
provenance contexts. They should not include raw prompts, raw model output,
full planner payloads, or unbounded tool results.

### Workflow metadata

For all profiles, blocked-before-generation and no-generation outcomes produce
a valid `WorkflowRecord`.

That record includes `workflowId`, `workflowName`, `status='degraded'`,
`terminationReason`, `stepCount`, `maxSteps`, and `maxDurationMs`.

When generation never occurred:

- `steps` may be empty when termination happens before the first executable
  step
- if any step executed before termination, emitted steps stay chronologically
  ordered with valid parent references

Profiles use the shared termination reason vocabulary rather than ad hoc
termination reason strings.

### Answer receipts and trace placement

Footnote can show compact workflow information near answers and richer detail
in traces.

The answer surface stays small. It can show the mode, whether review ran,
whether fallback happened, and whether a trace link is available. Detailed step
lists belong in the trace.

Short receipt text examples:

- `Answered in Balanced preset`
- `Reviewed before final answer`
- `Review skipped`
- `Planner fallback`
- `Grounding evidence was not available`

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

Information that explains the run after the fact usually belongs in the trace.
Information that helps the reader understand the answer at a glance can appear
in the footer.

### Review, fallback, and grounded wording

A review label means a review step ran. It does not mean the answer was
verified.

Use wording such as `reviewed`, `revised`, `skipped`, and `fallback`. Avoid
stronger claims such as `verified`.

Fallback should be visible in the trace. A fallback is not automatically a bad
result; it can mean Footnote returned the best available answer after one step
failed. If review failed open, search was unavailable, or a limit stopped the
workflow, the trace should say so.

Grounded mode describes evidence posture, not truth. UI copy can say that
Grounded mode used available source signals, that citations were included, or
that grounding evidence was not available for a response. That wording should
come from metadata such as citations, source usage, search or tool result
evidence, or an explicit evidence-unavailable state.

The mode name alone is not evidence. If runtime did not retrieve sources, check
citations, or record grounding evidence, UI copy should not imply that it did.

## Runtime boundaries

The Execution Contract sets the run rules. The workflow records the step
pattern used for the run. The orchestrator coordinates the request and
response. Planner suggests how to handle the request. Adapters run
provider-specific work. Trace and provenance explain what happened.

The web UI renders facts returned by the backend. It does not infer new
workflow meanings from raw metadata, invent budget numbers, or hide fallback to
make a run look cleaner.

Use this split when ownership is unclear:

| Concern             | Engine core                                                                                    | Workflow profile                                                        | Adapters and callers                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Step legality       | handles the legality check before execution                                                    | declares intended flow and policy toggles                               | supplies policy and uses engine legality results           |
| Limits              | handles hard-stop checks and stop-reason mapping                                               | declares default budgets within the shared limits model                 | passes config and surfaces the final result                |
| Workflow state      | tracks step count, token totals, current step, and lineage progression                         | declares expected step shape                                            | treats engine-produced workflow state as the runtime state |
| Step execution      | runs concrete steps today (`generate`, `assess`, refinement `generate`) and emits step records | defines step-specific behavior such as review parsing                   | builds requests and calls runtimes or providers            |
| Termination reasons | assigns shared termination reasons                                                             | can request stop using shared reason handling                           | persists and returns engine-assigned reasons unchanged     |
| Fail-open behavior  | handles degraded fail-open workflow behavior                                                   | can define recoverable profile behavior within shared fail-open meaning | keeps telemetry or persistence failures out of user blocks |

These rules stay stable as profiles expand:

- no step runs unless policy and legality allow it
- engine checks limits before bounded step execution
- engine assigns limit-exhaustion reasons
- profile recommendations are guidance; transition decisions still pass through
  the runtime checks
- mode chooses the kind of run first
- profile chooses the executable step shape second
- callers wire workflow into the app; workflow timing and legality come from
  the runtime path

## Workflow profile contract

Executable workflow profiles satisfy the contract defined in:

```text
packages/backend/src/services/workflowProfileContract.ts
```

Required profile fields:

- `profileId`
- `profileVersion`
- `displayName`
- `workflowName`
- `policy`
- `defaultLimits`
- `requiredHooks.initialStep`
- `requiredHooks.canEmitGeneration()`
- `requiredHooks.classifyNoGeneration(reasonCode)`

The policy defines capability toggles such as `enablePlanning`,
`enableToolUse`, `enableReplanning`, `enableGeneration`, `enableAssessment`,
and `enableRevision`.

The default limits define hard caps such as `maxWorkflowSteps`, `maxToolCalls`,
`maxPlanCycles`, `maxReviewCycles`, `maxDeliberationCalls` (compatibility
field), `maxTokensTotal`, and `maxDurationMs`.

Optional profile extensions can support review and refinement behavior. The
shared no-generation classification, disposition, and termination-reason
mapping remain part of the required profile contract.

## Limits and no-generation behavior

Workflow limits are backend-enforced stops, not model suggestions.

`WorkflowPolicy` defines legal transitions and capability toggles.

`ExecutionLimits` defines hard caps: `maxWorkflowSteps`, `maxToolCalls`,
`maxPlanCycles`, `maxReviewCycles`, `maxDeliberationCalls` (compatibility),
`maxTokensTotal`, and `maxDurationMs`.

Model output can recommend transitions only where policy allows. If a limit
stops a run, the workflow record includes that stop reason.

Profiles may narrow budgets. Hard-limit enforcement still happens in the
engine. Adapters may pass configured limits, but exhausted-limit reason codes
come from the workflow runtime.

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

Blocked or no-generation outcomes are explicit. When generation did not happen,
callers return the no-generation result instead of generated content. A stop
reason should not be surfaced in one path and hidden in another unless that
rule is documented.

## Where the code lives

The workflow engine mainly powers the reviewed chat path in:

```text
packages/backend/src/services/workflowEngine.ts
```

It handles transition checks, hard limits, bounded review/refinement execution,
termination reasons, fail-open handling, `WorkflowRecord` output, and
`StepRecord` output.

The shared workflow vocabulary includes `plan`, `tool`, `generate`, `assess`,
and `finalize`.

Current implementation responsibilities:

| Component          | Responsibility                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `workflowEngine`   | Runs reviewed workflow steps (`generate`, `assess`, refinement `generate`) and injected context steps.      |
| `chatOrchestrator` | Resolves mode/profile/contract, applies planner policy, and builds tool intent.                             |
| `chatService`      | Invokes `workflowEngine` and handles context-step short-circuit responses such as clarification or failure. |

Current first-slice review module posture:

- Supported modules are exactly `natural_human_style` and `concise_answer`.
- Module wording comes from shared prompts YAML fragments.
- Module selection is backend/profile-selected only.
- Planner hints and user-facing module controls are not active in this slice.

## Future work

Future workflow work may add first-class tool steps, replanning, broader
workflow diagrams, and user-facing workflow controls.

TODO(workflow-search-profile-split): Define and implement explicit split-model
execution for retrieval vs final generation. Current routing resolves one
selected response profile and may reroute that profile when search capability
is required, which prevents "search on profile A, generate on profile B" in one
request path.

Recommended boundary for that work:

- retrieval profile selection remains policy-governed and deterministic
- generation profile selection remains request or planner governed by routing
  strategy
- retrieval evidence joins runtime context and provenance before final
  generation
- trace and execution metadata report both retrieval and generation profile
  lineage

For now, workflow-facing UI should stay close to current metadata: mode, review
or fallback summary, grounding evidence availability, trace links, and
backend-provided usage data when present.

## Related docs

- [Context Integrations](./context-integrations/README.md)
- [Web Search](./context-integrations/web-search.md)
- [Answer Posture And Control Influence](./answer-posture-and-control-influence.md)
