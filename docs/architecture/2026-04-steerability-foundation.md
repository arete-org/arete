# Steerability Foundation (Internal Controls v1)

`steerabilityControls` is a small internal metadata layer for recording which
backend controls materially shaped a run. Its job is inspectability. Reviewers
should be able to look at a trace and see which controls mattered, where they
came from, and what part of execution they influenced.

This layer is not a policy engine. It does not introduce user-facing controls,
workflow scripting, or a second source of runtime authority. It explains
control-plane influence after the fact in a form that is serializable and easy
to inspect.

Each control record stores a control id, value, source, rationale,
`mattered`, and impacted targets.

## Control Classes

The v1 runtime shape is flat, but the controls are not interchangeable. The
distinctions below are architectural, not cosmetic.

Execution controls:

- `workflow_mode`
- `evidence_strictness`
- `review_intensity`
- `tool_allowance`

These controls can change execution behavior directly. They affect routing,
review behavior, evidence posture, or tool eligibility.

Presentation control:

- `persona_tone_overlay`

This control affects presentation only. It must not change
execution-contract authority, evidence strictness, or review authority.

Preference signal:

- `provider_preference`

This control expresses a request or advisory bias. It may influence selection,
but it is not authoritative by default.

These categories matter because traces must not blur execution policy,
presentation shaping, and advisory preference into one kind of influence.

## What `mattered` Means

`mattered = true` means the control had an observed material effect on the run
or the delivered answer.

Presence alone does not count. A control does not matter just because it is
visible in metadata, evaluated during routing, or carried through a trace. It
matters when it changes execution, review behavior, provider or profile
selection, tool eligibility, or final answer posture.

Examples:

- If no tool was requested, `tool_allowance` is usually visible but not
  material.
- If runtime considers a requested provider and then overrides it,
  `provider_preference` may still matter because it changed the selection path.
- If no overlay is applied, `persona_tone_overlay` does not matter.

`mattered` is an observed effect signal. It is not a claim of exclusive or
complete causal proof.

## Review Intensity

`review_intensity` must be derived from the same workflow behavior logic used
for runtime routing in `workflowProfileRegistry`.

That coupling matters because traces should report what the runtime actually
did, not what a separate metadata path inferred after the fact. If routing and
metadata derive from different logic, trace explanations eventually drift away
from runtime truth.

Current mapping:

- `none`: review excluded or disabled
- `light`: one deliberation pass
- `moderate`: two or three passes
- `high`: four or more passes

## Provider Preference

`provider_preference` is advisory unless policy says otherwise. Runtime may
honor it, override it, or replace it through fallback.

That state should remain visible in trace metadata:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

## Planner Activity in Execution Metadata

Planner activity belongs in `metadata.execution[]` as an explicit
`kind: "planner"` event. That event makes planner influence inspectable
without turning the planner into a second orchestrator.

### Required Planner Event Fields

- `purpose`: canonical invocation purpose
- `contractType`: planner contract path
- `applyOutcome`: how planner output was applied
- `mattered`: whether planner influence had observable impact in this run
- `matteredControlIds`: control ids that justify `mattered=true`

Current canonical values:

- `purpose = chat_orchestrator_action_selection`
- `contractType = structured | text_json | fallback`
- `applyOutcome = applied | adjusted_by_policy | not_applied`

### Field Semantics

`purpose` identifies the bounded planner role in the workflow. It should answer
what the planner was invoked to do, not describe the full outcome of the run.

`contractType` identifies the planner execution path. `fallback` means the
planner path ended in backend fail-open fallback semantics.

`applyOutcome` describes how planner output related to final execution:

- `applied`: planner output was used without material policy adjustment
- `adjusted_by_policy`: planner output was accepted as input but changed by
  policy, routing, or surface constraints before final execution
- `not_applied`: planner output did not become the execution path

`mattered` records observed downstream material effect through controls in this
run. `matteredControlIds` names the controls that justify that claim.

### Non-Claims

These planner fields should not be read more strongly than they are defined.

- `mattered` does not claim exclusive or complete causal proof.
- `adjusted_by_policy` does not mean planner output was discarded.
- `fallback` does not mean planner output was partially trusted.

### Current Linkage Assumptions

The current chat orchestrator emits one planner invocation per response path.
Execution ordering is planner-first in `metadata.execution[]`.

That assumption is sufficient for the current shape. If workflows later support
multiple planner invocations or retries, explicit correlation should be added
without allowing planner metadata to redefine orchestration authority.

### Examples

Canonical planner event:

```json
{
    "kind": "planner",
    "status": "executed",
    "purpose": "chat_orchestrator_action_selection",
    "contractType": "text_json",
    "applyOutcome": "applied",
    "mattered": true,
    "matteredControlIds": ["tool_allowance"],
    "profileId": "openai-text-fast",
    "provider": "openai",
    "model": "gpt-5-nano",
    "durationMs": 17
}
```

Policy-adjusted example:

```json
{
    "execution": [
        {
            "kind": "planner",
            "status": "executed",
            "purpose": "chat_orchestrator_action_selection",
            "contractType": "text_json",
            "applyOutcome": "adjusted_by_policy",
            "mattered": true,
            "matteredControlIds": ["tool_allowance"],
            "profileId": "openai-text-fast"
        },
        {
            "kind": "tool",
            "status": "executed",
            "toolName": "web_search",
            "reasonCode": "search_rerouted_to_fallback_profile"
        },
        {
            "kind": "generation",
            "status": "executed",
            "profileId": "openai-text-medium"
        }
    ],
    "steerabilityControls": {
        "version": "v1",
        "controls": [
            {
                "controlId": "tool_allowance",
                "source": "planner_output",
                "mattered": true
            },
            {
                "controlId": "provider_preference",
                "source": "planner_output",
                "mattered": false
            }
        ]
    }
}
```

## Bounded Future Extensions

Some seams are intentional and already constrained by current semantics.

- If planner adjustments become materially distinct in practice, add detail
  alongside `applyOutcome` rather than overloading the top-level enum.
- If multiple planner passes or retries are introduced, add explicit
  correlation while keeping planner ownership bounded by workflow logic.
- If runtime can revise TRACE posture during review, keep target TRACE and
  final TRACE separate. `workflowMode` remains routing metadata; TRACE remains
  answer-posture metadata.

The core rule stays the same: traces should describe runtime truth in a way
that remains legible to contributors and inspectable by reviewers.
