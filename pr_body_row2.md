## Summary
This PR simplifies chat execution to reflect the current reality: Footnote now has one workflow path, not multiple user-selectable workflow modes.

Core changes:
- Removed fast workflow mode selection from runtime config/routing.
- Removed `workflowMode` metadata from response contracts and runtime emission.
- Renamed canonical reviewed workflow identifiers (`bounded-review` -> `reviewed`) and related workflow naming (`message_with_review_loop` -> `message_reviewed`).
- Centralized workflow/review vocabulary in ethics-core where cross-package semantics are shared.
- Updated receipt/rendering and tests to describe what actually happened in execution, instead of exposing mode/profile routing metadata.

## Important decisions (plain English)
- **One real path beats fake choices**: We removed mode/profile surfaces because they suggested runtime choices that no longer exist.
- **Describe outcomes, not routing internals**: Metadata now focuses on concrete execution facts (steps, review runtime label, fallback/termination reasons), not policy-routing payloads.
- **Backward compatibility was intentionally not preserved**: old `workflowMode` compatibility was explicitly dropped to keep the model clean and truthful to current behavior.
- **Keep `workflow` terminology, but simplify it**: we did not move away from "workflow" as a concept; we removed plural/mode/profile branching semantics around it.
- **Fail-open behavior stays**: runtime still preserves fail-open behavior for execution and fallback handling.

## Notable implementation details
- Updated workflow registry/routing behavior to remove active fast-path usage and keep balanced/grounded reviewed execution behavior where still relevant in runtime inputs.
- Dropped `workflowMode` from `ResponseMetadata` and Zod schemas.
- Updated `reviewRuntime` derivation to rely on observed step execution signals.
- Simplified trace page and receipt messaging accordingly.

## Validation
- `pnpm lint`
- `pnpm validate-footnote-tags`
- `pnpm review`

All passed on this branch after rebase onto latest `main`.
