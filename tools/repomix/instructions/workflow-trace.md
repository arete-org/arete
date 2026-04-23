Focus on Footnote workflow and trace behavior.

Use these boundaries while analyzing this bundle:

- `packages/backend` owns runtime behavior and authority decisions.
- `packages/contracts` owns shared semantic contract types.
- `packages/web` should consume backend-provided semantics, not redefine them.
- Preserve fail-open behavior unless policy explicitly requires blocking.
- Treat provenance/trace/review semantics as first-class product behavior.

When proposing changes:

- prioritize small, focused diffs;
- avoid adding compatibility layers or migrations unless requested;
- keep authority decisions in backend code and docs aligned.
