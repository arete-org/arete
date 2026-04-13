# Bounded User Control Mapping

## Purpose

Define a small user-facing control surface for chat posture without exposing
internal authority knobs too early.

This doc is intentionally narrow. It says which choices users should see, what
those choices roughly mean, and which controls stay backend-owned.

## User-Facing Allowlist

The bounded user-facing set is:

- `fast`
- `balanced`
- `grounded`

These are the only user-facing choices in this design.

Do not add aliases, advanced toggles, or secondary sub-controls in this phase.

## Plain-Language Meaning

- `fast`: Prefer a quick answer path with lighter checking and minimal evidence
  work.
- `balanced`: Prefer a reviewed default path with a moderate evidence and review
  posture.
- `grounded`: Prefer the most careful path in this bounded set, with stricter
  evidence and review expectations.

These labels are meant to be humane. A user should be able to pick one without
needing to understand workflow internals, provider routing, or policy terms.

## Grounded Default Direction

`grounded` should be treated as the explicit default direction for the user
surface.

This is a product choice, not an accidental fallback. Footnote's stance is that
careful, reviewable, evidence-aware behavior should be the default posture
unless a different bounded user choice is made.

## High-Level Mapping

User choices map to intent and broad backend behavior, not to direct ownership
of internal control knobs.

- If the user chooses `fast`, the system should prefer a quicker execution path
  with lighter review and evidence expectations.
- If the user chooses `balanced`, the system should prefer the standard reviewed
  path with moderate evidence and review expectations.
- If the user chooses `grounded`, the system should prefer a stricter reviewed
  path with stronger evidence expectations.

In all three cases, backend-owned controls still decide the exact runtime shape,
limits, and conflict handling.

The user is choosing a bounded posture, not issuing low-level authority
commands.

## Internal-Only Controls

The following controls stay internal-only in this phase:

- `provider_preference`: Too easy to mistake for policy authority when it should
  remain advisory or backend-resolved.
- `persona_tone_overlay`: Presentation styling should not look like execution
  authority.
- detailed tool controls: Tool eligibility and routing are too low-level for an
  early humane surface.
- detailed review and evidence knobs: Exposing sub-knobs too early makes users
  guess which setting is the real authority.

The rule is simple: if a control is easy to misread as "the real policy knob,"
it should stay internal until Footnote has a stronger public control model.

## Contributor Examples

- If a user picks `grounded`, expose that choice as a stricter answer posture.
  Do not expose separate review-pass or evidence-threshold controls next to it.
- If a user picks `fast`, do not also surface provider or tool-routing choices
  as if they are equal policy controls. Those remain backend-owned.

## Boundaries

This doc does not define:

- UI rollout details
- API rollout details
- a final global override policy
- compatibility aliases
- speculative advanced control sets
