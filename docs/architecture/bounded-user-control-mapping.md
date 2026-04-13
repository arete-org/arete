# Bounded User Control Mapping

This doc defines the small user-facing control surface for chat.

## User-Facing Allowlist

For now, users get three choices only:

- `fast`
- `balanced`
- `grounded`

Do not add aliases, advanced toggles, or secondary sub-controls in this phase.

## What These Choices Mean

- `fast`: quickest path, with lighter checking and minimal evidence work
- `balanced`: standard reviewed path, with moderate evidence and review
- `grounded`: most careful path in this set, with stricter evidence and review
  expectations

These labels should be easy to understand. A user should not need to know
workflow internals, provider routing, or policy terms to pick one.

## Default Direction

`grounded` should be the default.

This is a product choice, not an accidental fallback. Footnote's stance is that
careful, reviewable, evidence-aware behavior should be the default posture
unless a different bounded user choice is made.

## How This Maps Internally

These choices map to broad backend behavior, not direct control of internal
knobs.

- If the user chooses `fast`, the system should prefer a quicker execution path
  with lighter review and evidence expectations.
- If the user chooses `balanced`, the system should prefer the standard
  reviewed path.
- If the user chooses `grounded`, the system should prefer a stricter reviewed
  path with stronger evidence expectations.

The backend still owns the exact runtime shape, limits, and conflict handling.

The user is picking a simple posture, not issuing low-level policy commands.

## What Stays Internal

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

## Examples

- If a user picks `grounded`, expose that choice as a stricter answer posture.
  Do not expose separate review-pass or evidence-threshold controls next to it.
- If a user picks `fast`, do not also surface provider or tool-routing choices
  as if they are equal policy controls. Those remain backend-owned.

## Not In Scope

This doc does not define:

- UI rollout details
- API rollout details
- a final global override policy
- compatibility aliases
- speculative advanced control sets
