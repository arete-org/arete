# Steerability Foundation (Internal Controls v1)

This pass adds a small internal metadata layer called `steerabilityControls`.
Its job is straightforward: show, in one place, which controls actually influenced a run so reviewers can verify behavior later.
It does not add user controls, workflow scripting, or a rule engine.

Each control record stores a control id, value, source, rationale, `mattered`, and impacted targets.

The current controls are:
`workflow_mode`, `evidence_strictness`, `review_intensity`,
`provider_preference`, `persona_tone_overlay`, and `tool_allowance`.

The runtime shape stays flat in v1, but these controls do not have equal authority.
Execution controls are `workflow_mode`, `evidence_strictness`, `review_intensity`, and `tool_allowance`.
`persona_tone_overlay` is a posture/output control.
`provider_preference` is a preference/environment control.
This distinction is important because tone and preference signals must not be treated like hard execution policy.

`mattered = true` means the control actually changed the run or the delivered answer.
A control does not matter just because it appears in metadata.
It matters when it changes execution path, review path, provider/profile resolution, tool eligibility, or answer posture.
For example: if no tool was requested, `tool_allowance` is usually visible but not material.
If runtime considers a requested provider and then overrides it, `provider_preference` may still matter because it affected selection logic.
If no overlay is applied, `persona_tone_overlay` does not matter.

`review_intensity` must be derived from the same workflow behavior logic used for runtime routing in `workflowProfileRegistry`.
If runtime behavior comes from one path and metadata comes from another, traces eventually misreport what happened.
Current mapping is:

- `none`: review excluded or disabled
- `light`: one deliberation pass
- `moderate`: two or three passes
- `high`: four or more passes

`provider_preference` is not authoritative by default.
Unless policy says otherwise, it is a request or advisory signal that runtime may honor, override, or replace through fallback.
The metadata should make that explicit with these states:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

`persona_tone_overlay` only affects presentation.
It must not change execution-contract authority, evidence strictness, or review authority.

What to remember:

- `workflow_mode` has more authority than `persona_tone_overlay`
- `provider_preference` is usually advisory
- `mattered` means the control actually changed behavior
- this layer explains runtime influence; it is not a policy engine
