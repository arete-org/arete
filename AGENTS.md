# Footnote Agent Contract

This is the main guidance file for AI coding agents in this repo.
Keep it short, clear, and current.

## Rule Architecture

- `AGENTS.md` is the canonical ruleset.
- Tool-specific files (for example `cursor.rules`, `.codexrules`, `.github/copilot-instructions.md`) are thin adapters.
- Adapters should only point to this file and include tool-only details when absolutely needed.

## Project Stage

Footnote is pre-1.0 and changing quickly.
Prefer fast, correct, small-scope delivery over broad compatibility planning.
Do not add migrations, backfills, or compatibility layers unless the user asks.

## What This Repo Is

Footnote is a transparency- and provenance-focused AI framework.
Main surfaces:

- `packages/backend`
- `packages/discord-bot`
- `packages/web`
- `packages/contracts`
- `packages/api-client`
- `packages/agent-runtime`
- `packages/prompts`

## Non-Negotiables

- Use `pnpm` commands.
- Use explicit TypeScript types. Avoid `any`.
- Use structured logging from `packages/discord-bot/src/utils/logger.ts`.
- Keep fail-open behavior: if uncertain, do not block execution.
- Preserve provenance comments and license headers.
- Keep `packages/backend` as the public runtime boundary for web and discord-bot.
- Keep Footnote provenance/trace/auth/incident/review semantics outside framework-specific adapters.
- Keep backend as the authority for LLM cost recording. Discord/web should display cost data already computed by backend or shared pricing helpers.
- Keep public interfaces serializable.

## Required Module Header Format

Use this exact order and include a short rationale on risk and ethics lines.

```ts
/**
 * @description: <1-3 lines>
 * @footnote-scope: <core|utility|interface|web|test>
 * @footnote-module: <ModuleName>
 * @footnote-risk: <low|medium|high> - <technical blast radius>
 * @footnote-ethics: <low|medium|high> - <human/governance impact>
 */
```

## API Boundary Rule

For API boundary changes, keep links in sync:

- code annotations: `@api.operationId` and `@api.path`
- OpenAPI refs: `x-codeRefs` in `docs/api/openapi.yaml`

## Validation Commands

After edits:

- `pnpm lint:fix`

Before final handoff:

- `pnpm lint`

When relevant:

- `pnpm validate-footnote-tags`
- `pnpm validate-openapi-links` (API boundary changes)
- `pnpm review` (cross-cutting or review-ready changes)
- `docker compose -f deploy/compose.yml build` (deploy/runtime packaging impact)

## Working Style

- Prefer small, focused diffs.
- Edit only files needed for the task.
- For non-trivial structural refactors, include 1-2 example evidence links using `pnpm refactor:lookup`.
- Do not invent runtime facts, command output, or test results.
- If a check was not run, say that clearly.

## Communication Style

Write for a junior contributor:

- Plain language first.
- Short sentences.
- Concrete action words.
- Comments should explain purpose, trigger, and consequence.
