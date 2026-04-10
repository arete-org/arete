# Steerability Foundation (Internal Controls v1)

This document explains the first steerability foundation pass in plain language.

The key idea is simple: we want internal controls that are meaningful and inspectable now, so later user-facing controls can map cleanly to real runtime behavior. We are not building a workflow language or user scripting surface in this phase.

## What v1 added

We added one backend-owned metadata bundle: `steerabilityControls`.

Each control record includes:

- control id
- value
- source
- rationale
- `mattered` flag
- impacted execution targets

This gives operators a compact explanation of what shaped a run, without pretending we already have a complete policy engine.

## Control set (unchanged in this hardening pass)

- `workflow_mode`
- `evidence_strictness`
- `review_intensity`
- `provider_preference`
- `persona_tone_overlay`
- `tool_allowance`

## Control classes (documentation semantics, flat runtime shape)

The runtime payload stays flat in v1. We are not introducing nested classes in schema yet.  
To avoid conceptual drift, contributors should read controls as belonging to these authority classes:

- Execution controls:
    - `workflow_mode`
    - `evidence_strictness`
    - `review_intensity`
    - `tool_allowance`
- Posture/output control:
    - `persona_tone_overlay`
- Preference/environment control:
    - `provider_preference`

The important point: these classes are not equal in authority. A tone overlay does not have the same authority as workflow mode or execution contract policy.

## `mattered` definition (causal, not decorative)

`mattered = true` means the control had an observable causal impact on this run.

It does not mean:

- the record existed
- the control was merely requested
- the control was accepted but did not materially change behavior

Concrete examples:

- Requested but overridden: `provider_preference` can still matter if policy resolves a different profile.
- Not consequential: if no tool was requested, `tool_allowance` is still visible but `mattered = false`.
- Materially consequential: `workflow_mode` selecting a reviewed path sets `mattered = true`.
- No posture change: if no persona overlay is applied, `persona_tone_overlay` is `mattered = false`.

## `review_intensity` derivation policy

`review_intensity` is now derived from one canonical workflow-mode helper in `workflowProfileRegistry`.

Why this matters: if mode behavior and metadata use different derivation paths, traces eventually drift and inspectability breaks.

Current thresholds:

- `none`: review path excluded/disabled
- `light`: one deliberation pass
- `moderate`: two or three passes
- `high`: four or more passes

## `provider_preference` semantics

`provider_preference` remains non-authoritative unless policy explicitly makes it authoritative.

The value/rationale now makes resolution state explicit:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

This keeps records honest about intent versus outcome.

## `persona_tone_overlay` constraint

`persona_tone_overlay` is presentation/posture only.

It must not:

- change execution-contract authority
- change evidence strictness
- bypass review authority

Tests assert this expectation so future edits do not quietly broaden tone semantics into execution authority.

## What this pass did not do

- No new controls
- No user-facing knobs
- No DSL or open-ended rule engine
- No schema expansion for control classes

This stays a bounded foundation pass: clearer semantics first, broader capability later.
