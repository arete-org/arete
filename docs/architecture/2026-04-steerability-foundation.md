# Steerability Foundation (Internal Controls v1)

This doc explains the first steerability layer in plain language.

The goal is simple: record what influenced a run in a way humans can inspect later.  
This is not a rule engine. This is not user workflow programming.

## What this system is

`steerabilityControls` is a metadata bundle attached to response metadata.

Each control record stores:

- control id
- value
- source
- rationale
- `mattered`
- impacted targets

Why we added this: without a canonical record, control logic gets scattered across logs and code paths, and reviewers cannot quickly tell what actually influenced a response.

## What this system is not

This pass is intentionally small.

- No new controls
- No user-facing knobs
- No DSL
- No open-ended rules engine

Why we are strict here: expanding power before semantics are stable is how systems become confusing and hard to trust.

## Current control set (v1)

- `workflow_mode`
- `evidence_strictness`
- `review_intensity`
- `provider_preference`
- `persona_tone_overlay`
- `tool_allowance`

## Control groups and authority

The runtime payload stays flat in v1. We did not change schema shape again yet.

But contributors still need to think in groups. If we do not do that, people will treat all controls as equally powerful, and that is wrong.

- Execution controls:
    - `workflow_mode`
    - `evidence_strictness`
    - `review_intensity`
    - `tool_allowance`
- Posture/output control:
    - `persona_tone_overlay`
- Preference/environment control:
    - `provider_preference`

Failure mode we are preventing: tone controls or advisory preferences being treated like hard execution policy.

## `mattered` meaning

`mattered = true` means this control changed something real about the run or the final answer.

Seeing a control record in metadata is not enough.

What counts as real change:

- execution path changed
- review path changed
- provider/profile resolution changed
- tool eligibility changed
- delivered answer posture changed

What does not count:

- control was present but had no downstream effect
- control was requested but ignored with no material impact

Examples:

- If no tool was requested, `tool_allowance` is visible but usually `mattered = false`.
- If runtime overrides requested provider/profile, `provider_preference` can still matter because it changed selection logic.
- If no overlay is applied, `persona_tone_overlay` is `mattered = false`.

## `review_intensity` derivation

`review_intensity` must come from one source of truth: workflow-mode behavior derivation in `workflowProfileRegistry`.

Why this matters: if runtime behavior comes from one place and metadata comes from another, traces eventually lie about what happened.

Current mapping:

- `none`: review excluded or disabled
- `light`: one deliberation pass
- `moderate`: two or three passes
- `high`: four or more passes

## `provider_preference` semantics

`provider_preference` is not automatically authoritative.

Unless policy explicitly says otherwise, it is a request or advisory signal that runtime may override.

The record now makes outcome explicit:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

Why this matters: the trace should clearly show whether the system followed the preference, overrode it, or fell back.

## `persona_tone_overlay` constraint

`persona_tone_overlay` controls presentation and tone only.

It must not:

- change execution-contract authority
- change evidence strictness
- bypass review authority

Failure mode we are preventing: style-level controls quietly becoming policy controls.

## What to remember

- `workflow_mode` has more authority than `persona_tone_overlay`.
- `provider_preference` is a signal unless policy elevates it.
- `mattered = true` means the control changed something real.
- `review_intensity` must be derived from the same logic path as workflow routing.
- This layer is metadata-first for inspection, not a runtime rule engine.
