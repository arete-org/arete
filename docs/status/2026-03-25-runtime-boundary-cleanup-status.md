# Runtime Boundary Cleanup Status

## Last Updated

2026-03-25

## Purpose

Track the current repo state for the runtime-boundary cleanup branch.

This is a current-state audit, not a branch closeout. It records what is done, what is only partially in place, and what still has not started for this cleanup branch.

## Scope

This note covers only the cleanup-branch items tracked in this status snapshot:

- deletion of `createLegacyOpenAiRuntime` and its remaining test/export surface
- splitting `packages/discord-bot/src/index.ts`
- moving OpenAI SDK error imports out of `discord-bot`
- optional VoltOps tracing enablement

Out of scope:

- Phase 2 boundary consolidation
- provider abstraction work beyond this cleanup branch
- memory, workflows, or other new VoltAgent features
- new product features

## Status Summary

This cleanup branch is not complete.

Current repo state shows:

- `2/4` cleanup-branch items are complete
- `1/4` is partial
- `1/4` is not started

The remaining blockers are concentrated in the Discord bot's provider-neutral cleanup: removing the last OpenAI SDK error/type imports and deciding whether to enable optional VoltOps tracing.

## Cleanup Branch Exit Gates And Evidence

### 1. Legacy OpenAI Runtime Deletion

Status: Complete

Evidence:

- [packages/backend/src/server.ts](/Users/Jordan/Desktop/footnote/packages/backend/src/server.ts) now creates the text runtime directly with `createVoltAgentRuntime()` and no longer constructs a legacy fallback runtime.
- [packages/agent-runtime/src/index.ts](/Users/Jordan/Desktop/footnote/packages/agent-runtime/src/index.ts) now exposes only the VoltAgent-backed text runtime factory for the shared generation seam.
- [packages/agent-runtime/package.json](/Users/Jordan/Desktop/footnote/packages/agent-runtime/package.json) no longer exports `./legacyOpenAiRuntime`.
- [packages/agent-runtime/src/legacyOpenAiRuntime.ts](/Users/Jordan/Desktop/footnote/packages/agent-runtime/src/legacyOpenAiRuntime.ts) and [packages/agent-runtime/test/legacyOpenAiRuntime.test.ts](/Users/Jordan/Desktop/footnote/packages/agent-runtime/test/legacyOpenAiRuntime.test.ts) have been removed.

Still needed:

- no further code cleanup is required for this item; future work only needs to keep the legacy runtime path from being reintroduced

### 2. Split `packages/discord-bot/src/index.ts`

Status: Complete

Evidence:

- Interaction routing in [packages/discord-bot/src/index.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/index.ts) now delegates to dedicated interaction modules instead of owning select, modal, and button business logic directly.
- Select menu handling was extracted to [packages/discord-bot/src/interactions/selectMenuHandlers.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/selectMenuHandlers.ts).
- Modal submit handling was extracted to [packages/discord-bot/src/interactions/modalSubmitHandlers.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/modalSubmitHandlers.ts).
- Button handling (provenance, incident, variation, retry) was extracted to [packages/discord-bot/src/interactions/buttonHandlers.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/buttonHandlers.ts), with shared variation status text in [packages/discord-bot/src/interactions/variationStatus.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/variationStatus.ts).
- The button module is now further split so [packages/discord-bot/src/interactions/buttonHandlers.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/buttonHandlers.ts) acts as a thin dispatcher over focused modules:
  [packages/discord-bot/src/interactions/button/provenanceButtons.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/button/provenanceButtons.ts),
  [packages/discord-bot/src/interactions/button/incidentButtons.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/button/incidentButtons.ts),
  [packages/discord-bot/src/interactions/button/variationButtons.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/button/variationButtons.ts),
  [packages/discord-bot/src/interactions/button/retryButtons.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/button/retryButtons.ts), and
  [packages/discord-bot/src/interactions/button/shared.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/interactions/button/shared.ts).

Still needed:

- no further split is required for this item; future work should keep `index.ts` as routing/orchestration only

### 3. Move OpenAI Error Imports Out Of `discord-bot`

Status: Partial

Evidence:

- [packages/discord-bot/src/commands/image/errors.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/commands/image/errors.ts) still imports `APIError` from `openai/error` and `Response` types from the OpenAI SDK.
- [packages/discord-bot/src/commands/image/types.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/commands/image/types.ts) still imports `ResponseOutputItem` from the OpenAI SDK.
- Repo search in `packages/discord-bot/src` found the remaining direct SDK imports concentrated in the image command area rather than spread across the whole bot, so this cleanup is narrower than it used to be.

Still needed:

- replace OpenAI-specific error typing in the bot with Footnote-owned or provider-neutral shapes
- remove OpenAI response-type imports from Discord image helpers
- remove the `openai` package from `@footnote/discord-bot` if nothing else still needs it after the type cleanup

### 4. Optional VoltOps Tracing Enablement

Status: Not Started

Evidence:

- [packages/backend/src/utils/voltagentLogger.ts](/Users/Jordan/Desktop/footnote/packages/backend/src/utils/voltagentLogger.ts) sets up rotating local log files for VoltAgent-compatible logs, but this is local logging, not VoltOps tracing.
- [.env.example](/Users/Jordan/Desktop/footnote/.env.example) does not declare `VOLTAGENT_PUBLIC_KEY` or `VOLTAGENT_SECRET_KEY`.
- Repo search did not find VoltOps client wiring or other official VoltAgent observability setup in runtime or deploy code.

Still needed:

- add VoltOps env/config wiring if this cleanup branch wants the optional observability win
- keep VoltOps clearly separate from Footnote trace storage and provenance semantics
- document that this item is optional and not a gate for the rest of this cleanup branch

## Validation Snapshot

This status note is based on repo inspection plus the validation commands run on 2026-03-25.

Primary inspection commands and checks:

- `rg -n "createLegacyOpenAiRuntime|legacyOpenAiRuntime" packages docs scripts -S`
- `rg -n -F "openai" packages/discord-bot/src`
- `rg -n "pnpm review|docker compose -f deploy/compose.yml build|Dockerfile" docs AGENTS.md cursor.rules deploy -S`
- direct inspection of backend startup, SQLite store, Discord bot, and deploy files
- `pnpm review`
- `docker compose -f deploy/compose.yml build`

## Remaining Gaps

- `discord-bot` still carries a small but real OpenAI SDK type/error dependency
- optional VoltOps tracing has not been wired yet

## Out Of Scope

This note does not report progress for later workstreams except to mark them as outside this audit. It also does not replace the durable architecture decisions already recorded in:

- [docs/decisions/2026-03-voltagent-runtime-adoption.md](/Users/Jordan/Desktop/footnote/docs/decisions/2026-03-voltagent-runtime-adoption.md)
- [docs/decisions/2026-03-legacy-openai-removal-and-runtime-branching.md](/Users/Jordan/Desktop/footnote/docs/decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)
