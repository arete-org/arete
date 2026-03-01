## AGENTS.md

This file provides default context for automation tools (Codex, Cursor) so work is productive without manually selecting files.

## Project Overview

- Monorepo for Footnote (a transparency- and provenance-focused AI framework) with Discord bot, backend core, and web site.
- Core principles: interpretability, traceability, cost tracking, fail-open behavior.
- Required annotations: `@arete-module`, `@arete-risk`, `@arete-ethics`, `@arete-scope`.
- Structured logging is mandatory; use scoped loggers from `packages/discord-bot/src/utils/logger.ts`.

## Primary Entrypoints

- Discord bot runtime: `packages/discord-bot/src/index.ts`
- Backend core: `packages/backend/src`
- Web app: `packages/web/src`
- Server wrapper: `server.js`
- Environment templates: `.env.example`
- Project docs: `README.md`, `docs/Philosophy_new.md`, `SECURITY.md`

## Preferred Context (load first)

- `cursor.rules` (authoritative development rules)
- `packages/discord-bot/src/utils/env.ts`
- `packages/discord-bot/src/utils/logger.ts`
- `packages/discord-bot/src/state/ChannelContextManager.ts`
- `packages/backend/src/storage/incidents/incidentStore.ts`
- `packages/backend/src/utils/pseudonymization.ts`

## When Editing

- Preserve provenance comments and licensing headers.
- Use explicit types; avoid `any`.
- Record LLM costs via `ChannelContextManager.recordLLMUsage()`.
- Keep interfaces serializable for future UI integration.
- Use fail-open design: if uncertain, do not block execution.
- For API boundary code, keep OpenAPI links current:
  - code annotations: `@api.operationId` + `@api.path`
  - spec references: `x-codeRefs` in `docs/api/openapi.yaml`

## Communication Style

- Prefer a junior-friendly teaching tone by default.
- Explain decisions in plain language first, then include technical detail.
- Keep explanations concrete and actionable.

## Current `@arete-*` Header Format

- Order: `@description`, `@arete-scope`, `@arete-module`, `@arete-risk`, `@arete-ethics` (colon required).
- Risk/Ethics annotations must include a short rationale on the same line.
- Canonical reference: `docs/architecture/footnote-annotations.md`.

Example:

```ts
/**
 * @description: Handles realtime audio streaming and event dispatch for the bot.
 * @arete-scope: core
 * @arete-module: RealtimeEventHandler
 * @arete-risk: high - Audio/event failures can break live conversations or leak resources.
 * @arete-ethics: high - Realtime audio handling impacts privacy and consent expectations.
 */
```

## Testing & Validation

- Pre-review: `pnpm pre-review`
- `@arete-*` tags: `pnpm validate-arete-tags`
- OpenAPI linking: `pnpm validate-openapi-links`

## CodeRabbit CLI

- CodeRabbit is installed in the terminal and can be used for code review support.
- Run `cr -h` to view available commands.
- Prefer CodeRabbit with `--prompt-only`.
- To review uncommitted changes: `coderabbit --prompt-only -t uncommitted`.
- Run CodeRabbit no more than 3 times per set of changes.

## Context Hints

- Bot: `packages/discord-bot/src/events`, `packages/discord-bot/src/commands`, `packages/discord-bot/src/voice`
- Realtime audio: `packages/discord-bot/src/realtime`
- Shared prompts: `packages/backend/src/services/prompts`
- Web UI: `packages/web/src/components`, `packages/web/src/pages`

## Exclusions

Avoid loading secrets, logs, traces, or build artifacts (see `.codexignore`).
