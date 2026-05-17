# Branch Status: feat/trace-temperament-contract

Last updated: 2026-05-17

## Goal

Define and centralize TRACE temperament semantics so default posture and level
meanings are clear, compact, and prompt-ready.

## Minimum Scope (Current)

- canonical TRACE default anchor is `3`
- level matrix for `1..5` across all TRACE axes
- YAML-first prompt-configuration shape for low-token always-on guidance

## Progress

- [x] Branch created and checked out
- [x] Standalone architecture contract doc drafted
- [x] Architecture reading guide linked to contract
- [x] TRACE posture architecture doc linked to contract
- [x] Prompt YAML source added/updated
- [x] Prompt assembly wiring updated to use matrix source
- [x] Backend normalization/default helper alignment reviewed
- [x] Tests added for defaulting and matrix-driven behavior

## Settled Decisions

- Keep planner fallback behavior as-is: missing temperament stays missing on
  fallback.
- Keep first shipped matrix global-only (no surface/profile variants).
- Enforce exact v1 parity by rendering planner TRACE rubric from one YAML source.

## Notes

- Keep this status doc lightweight. It tracks branch reality, not long-term
  architecture.
- Update when scope changes or implementation starts landing.
