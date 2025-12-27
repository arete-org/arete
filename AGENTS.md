## AGENTS.md

This file provides default context for automation tools (Codex, Cursor) so work is productive without manually selecting files.

## Project Overview
- Monorepo for ARETE (ethics-first AI framework) with Discord bot, backend core, and web site.
- Core principles: interpretability, traceability, cost tracking, fail-open behavior.
- Required annotations: `@arete-module`, `@arete-risk`, `@arete-ethics`, `@arete-scope`.
- Structured logging is mandatory; use scoped loggers from `packages/discord-bot/src/utils/logger.ts`.

## Primary Entrypoints
- Discord bot runtime: `packages/discord-bot/src/index.ts`
- Backend core: `packages/backend/src`
- Web app: `packages/web/src`
- Server wrapper: `server.js`
- Environment templates: `.env.example`
- Project docs: `README.md`, `docs/PHILOSOPHY.md`, `docs/SECURITY.md`

## Preferred Context (load first)
- `cursor.rules` (authoritative development rules)
- `packages/discord-bot/src/utils/env.ts`
- `packages/discord-bot/src/utils/logger.ts`
- `packages/discord-bot/src/state/ChannelContextManager.ts`
- `packages/backend/src/shared/incidentStore.ts`
- `packages/backend/src/shared/pseudonymization.ts`

## When Editing
- Preserve provenance comments and licensing headers.
- Use explicit types; avoid `any`.
- Record LLM costs via `ChannelContextManager.recordLLMUsage()`.
- Keep interfaces serializable for future UI integration.
- Use fail-open design: if uncertain, do not block execution.

## ARETE Header Format
- Order: `@description`, `@arete-scope`, `@arete-module`, `@arete-risk`, `@arete-ethics` (colon required).
- Risk/Ethics annotations must include a short rationale on the same line.
- Canonical reference: `docs/architecture/arete-annotations.md`.

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
- Pre-review: `npm run pre-review`
- ARETE tags: `npm run validate-arete-tags`
- Ethics/risk audits: `npm run ethics-check && npm run risk-check`

## Context Hints
- Bot: `packages/discord-bot/src/events`, `packages/discord-bot/src/commands`, `packages/discord-bot/src/voice`
- Realtime audio: `packages/discord-bot/src/realtime`
- Shared prompts: `packages/backend/src/shared/prompts`
- Web UI: `packages/web/src/components`, `packages/web/src/pages`

## Exclusions
Avoid loading secrets, logs, traces, or build artifacts (see `.codexignore`).
