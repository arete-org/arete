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

## Explicit non-goals respected

- No workflow DSL.
- No user scripting.
- No open-ended rule engine.
- No full user-facing control authoring.

This is a bounded internal foundation so future `/chat` controls or plain-language steering can map to stable concepts without redesigning runtime internals.
