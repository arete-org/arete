# Steerability Foundation (Internal Controls v1)

## What was done

1. Added a canonical internal control record in shared contracts.

- New `ResponseMetadata.steerabilityControls` in `@footnote/contracts/ethics-core`.
- Record shape is serializable and explicit:
    - control id
    - value
    - source
    - rationale
    - whether it mattered
    - impacted execution targets

2. Added bounded control concepts (v1).

- `workflow_mode`
- `evidence_strictness`
- `review_intensity`
- `provider_preference`
- `persona_tone_overlay`
- `tool_allowance`

3. Added backend control normalization.

- New backend module resolves orchestration/runtime state into one control bundle.
- Control mapping is derived from existing architecture decisions, not ad hoc flags.

4. Wired controls into response metadata + traces.

- `chatOrchestrator` now builds controls from resolved workflow mode, execution contract, profile routing, persona overlay source, and tool eligibility.
- `chatService` and metadata builder pass/store the controls unchanged.

5. Added validation/tests.

- Contract schema now validates `steerabilityControls`.
- Added schema tests and backend metadata/control resolver tests.

## Why this matches the epic

- Meaningful controls: each control maps to a real execution choice.
- Inspectable controls: controls are emitted in metadata/traces with source + rationale.
- Clean execution mapping: each control includes impacted targets.
- Explainable traces: `mattered` + impacted targets show which controls affected behavior.

## Control Classes (v1, flat bundle)

The runtime metadata shape remains flat in v1. Control authority classes are documented here to prevent conceptual drift.

- Execution controls:
    - `workflow_mode`
    - `evidence_strictness`
    - `review_intensity`
    - `tool_allowance`
- Posture/output controls:
    - `persona_tone_overlay`
- Preference/environment controls:
    - `provider_preference`

These classes are documentation semantics only in v1. They do not add new schema fields.

## `mattered` Semantics

`mattered = true` means the control had an observable causal impact on this run.

It is not enough that:

- the control record existed
- the control was requested
- the control was accepted but had no material effect

Examples:

- Requested but not honored: `provider_preference` may still matter when policy overrides it and resolves a different profile.
- Honored but not consequential: if no tool was requested, `tool_allowance` is present but `mattered = false`.
- Materially consequential: `workflow_mode` selecting grounded behavior and enabling reviewed path sets `mattered = true`.
- No downstream effect: no persona overlay keeps `persona_tone_overlay` as `mattered = false`.

## Provider Preference Semantics

`provider_preference` remains non-authoritative unless policy explicitly grants authority.

v1 value/rationale encoding is explicit about resolution state:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

This keeps traces honest about request/advisory intent vs runtime policy resolution.

## Persona Overlay Constraint

`persona_tone_overlay` is presentation/posture only.

It must not:

- alter execution-contract authority
- lower/raise evidence strictness
- bypass review authority

Tests assert rationale language to keep this contract explicit during future edits.

## Explicit non-goals respected

- No workflow DSL.
- No user scripting.
- No open-ended rule engine.
- No full user-facing control authoring.

This is a bounded internal foundation so future `/chat` controls or plain-language steering can map to stable concepts without redesigning runtime internals.
