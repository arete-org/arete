Focus on architecture and proposal quality.

Use these rules while analyzing this bundle:

- Architecture docs are the current source of truth.
- Proposal docs are exploratory until accepted and adopted.
- Backend remains the public runtime boundary for web and discord-bot.
- Do not infer runtime behavior from archived status notes.

When giving recommendations:

- anchor suggestions in current architecture docs and cited code paths;
- highlight boundary or authority drift explicitly;
- avoid broad refactors unless they are required by the proposal scope.

Concrete checks to perform:

- when a proposal claims a boundary change, confirm the exact backend/contracts/web files that would change;
- when a proposal references workflow/trace semantics, verify the same terms exist in `docs/architecture`, contracts types/schemas, and backend services;
- if docs and code disagree, call out the mismatch directly and recommend whether docs or code should be updated first.
