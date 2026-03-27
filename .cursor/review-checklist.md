# Review Checklist

Use this as a short pre-PR gate.
Canonical guidance lives in `AGENTS.md`.

## Core Checks

- [ ] `pnpm lint:fix` (after edits)
- [ ] `pnpm lint`

## Conditional Checks

Run these when relevant:

- [ ] `pnpm validate-footnote-tags` (when changed files include module headers)
- [ ] `pnpm validate-openapi-links` (when API boundary code, `@api.operationId`/`@api.path`, or OpenAPI `x-codeRefs` changed)
- [ ] `pnpm review` (cross-cutting or review-ready changes)
- [ ] `docker compose -f deploy/compose.yml build` (changes can affect deployable packaging/runtime)

## Change Integrity

- [ ] Changed modules keep the required header format and order:
    - `@description`
    - `@footnote-scope`
    - `@footnote-module`
    - `@footnote-risk` (`low|medium|high` + short rationale)
    - `@footnote-ethics` (`low|medium|high` + short rationale)
- [ ] Summary does not claim checks that were not run.
- [ ] No invented runtime facts, outputs, or test results.
- [ ] Backend remains the authority for LLM cost recording.
- [ ] Provenance comments and license headers are preserved.

## Done Criteria

- [ ] Required checks passed.
- [ ] Any skipped checks are called out clearly in the final summary.
