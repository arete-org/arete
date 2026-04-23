Focus on Footnote workflow and trace behavior.

Use these boundaries while analyzing this bundle:

- `packages/backend` owns runtime behavior and authority decisions.
- `packages/contracts` owns shared semantic contract types.
- `packages/web` should consume backend-provided semantics, not redefine them.
- Preserve fail-open behavior unless policy explicitly requires blocking.
- Treat provenance/trace/review semantics as product behavior, not debug-only metadata.

When proposing changes:

- prioritize small, focused diffs;
- avoid adding compatibility layers or migrations unless requested;
- keep authority decisions in backend code and docs aligned.

Concrete checks to perform:

- verify trace field names and meanings match across backend handlers/routes, contracts, and the Trace page;
- verify workflow profile terms in docs match workflow profile contract/runtime names in code;
- if a field is added or renamed, identify all three touch points: backend producer, contract type/schema, and web renderer.
