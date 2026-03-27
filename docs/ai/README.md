# AI Assistance Guide (For Contributors)

This page is for people working in the Footnote repo.
It explains how to use AI tools responsibly and how to review AI-generated changes.

## Audience

- New contributors
- Junior developers
- Maintainers reviewing AI-assisted PRs

## Where Rules Live

- `AGENTS.md` is the only canonical ruleset for agent behavior.
- Tool-specific files (`cursor.rules`, `.codexrules`, `.github/copilot-instructions.md`) are thin adapters.

If you see conflicting guidance, trust `AGENTS.md`.

## Practical Workflow

1. Start with a small, focused change.
2. Ask AI for implementation help or review help.
3. Validate the result with project checks.
4. Do a human pass before opening a PR.

## Checks to Run

Always:

- `pnpm lint:fix` after edits
- `pnpm lint` before final handoff or PR

When relevant:

- `pnpm validate-footnote-tags`
    - Run when you add or edit module headers, or create new modules.
- `pnpm validate-openapi-links`
    - Run when you change API boundary code, `@api.operationId`/`@api.path` annotations, or `docs/api/openapi.yaml` `x-codeRefs`.
- `pnpm review`
    - Run for cross-cutting changes (multiple packages, shared contracts, validators, or policy-sensitive paths).
- `docker compose -f deploy/compose.yml build`
    - Run when a change can affect deployable runtime packaging (service startup, build/deploy config, runtime dependencies).

## Refactor/Design Example Lookup

Use `pnpm refactor:lookup` when making non-trivial structural changes and you want example-backed guidance.

Example:

- `pnpm refactor:lookup --kind technique --query \"extract method\"`
- `pnpm refactor:lookup --kind pattern --query \"strategy\" --format md`
- `pnpm refactor:lookup --kind pattern --query \"strategy\" --format md --quiet-notes`

Intent routing:

- `smell` and `technique` queries prioritize `RefactoringGuru/refactoring-examples`.
- `pattern` and `typescript-design` queries prioritize `RefactoringGuru/design-patterns-typescript`.
- The lookup automatically falls back to the secondary repo when primary confidence is low.
- Routing and aliases are versioned in `docs/ai/refactor_lookup_map.json`.

## Human Review Checklist

Use this quick checklist before merge:

- The change solves the intended problem.
- The diff is scoped and understandable.
- Public boundaries still look correct (`backend` remains the public boundary for web/discord-bot).
- Backend remains the authority for LLM cost recording.
- Logging, provenance, and fail-open behavior are preserved.
- Provenance comments and license headers are preserved.
- Module headers use the required `@footnote-*` format and order.
- PR summary does not claim checks that were not run.

## Common Mistakes to Catch

- AI adds broad refactors when a small fix is enough.
- AI introduces compatibility layers, migrations, or backfills that were not requested.
- AI updates behavior without updating validation or tests.
- AI writes summaries that imply checks passed when they were not run.

## Keeping This Guide Healthy

- Keep this page short and human-friendly.
- Put policy changes in `AGENTS.md`, not here.
- Update this page only when onboarding or review flow changes.
