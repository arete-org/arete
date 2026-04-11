# Steerability Foundation (Internal Controls v1)

This pass adds a small internal metadata layer called `steerabilityControls`.
It records which controls actually influenced a run so reviewers can check that later.
It does not add user controls, workflow scripting, or a rule engine.

Each control record stores a control id, value, source, rationale, `mattered`, and impacted targets.

The current controls are:
`workflow_mode`, `evidence_strictness`, `review_intensity`,
`provider_preference`, `persona_tone_overlay`, and `tool_allowance`.

The runtime shape stays flat in v1, but the controls are not equal.
`workflow_mode`, `evidence_strictness`, `review_intensity`, and `tool_allowance` are execution controls.
`persona_tone_overlay` only affects presentation.
`provider_preference` is a preference signal.
That distinction matters because tone or preference must not be mistaken for execution policy.

`mattered = true` means the control actually changed the run or the delivered answer.
A control does not matter just because it appears in metadata.
It matters when it changes execution, review, provider or profile selection, tool eligibility, or the final answer posture.
For example: if no tool was requested, `tool_allowance` is usually visible but not material.
If runtime evaluates a requested provider and then overrides it, `provider_preference` may still matter because it changed the selection path.
If no overlay is applied, `persona_tone_overlay` does not matter.

`review_intensity` must be derived from the same workflow behavior logic used for runtime routing in `workflowProfileRegistry`.
If runtime behavior comes from one path and metadata comes from another, traces eventually misreport what happened.
The current mapping is:

- `none`: review excluded or disabled
- `light`: one deliberation pass
- `moderate`: two or three passes
- `high`: four or more passes

`provider_preference` is not authoritative by default.
Unless policy says otherwise, it is a request or advisory signal that runtime may honor, override, or replace through fallback.
The trace should make that explicit with these states:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

`persona_tone_overlay` only affects presentation.
It must not change execution-contract authority, evidence strictness, or review authority.

In practice:

- `workflow_mode` has more authority than `persona_tone_overlay`
- `provider_preference` is usually advisory
- `mattered` means the control actually changed behavior
- this layer explains runtime influence; it is not a policy engine

## Planner Activity Event Fields (Execution/Provenance)

Planner activity must be explicit in `metadata.execution[]` with a `kind: "planner"` event.
These fields are canonical and required for planner events:

- `purpose`: canonical invocation purpose (`chat_orchestrator_action_selection`)
- `contractType`: planner contract path (`structured`, `text_json`, or `fallback`)
- `applyOutcome`: how planner output was applied (`applied`, `adjusted_by_policy`, or `not_applied`)
- `mattered`: whether planner influence had observable impact on this run
- `matteredControlIds`: steerability control ids that justify `mattered=true`

Canonical example:

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
