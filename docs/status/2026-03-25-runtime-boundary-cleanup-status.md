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
- `pnpm review` as the standard review gate for this cleanup branch
- Docker image validation for the deployable services
- optional VoltOps tracing enablement

Out of scope:

- Phase 2 boundary consolidation
- provider abstraction work beyond this cleanup branch
- memory, workflows, or other new VoltAgent features
- new product features

## Status Summary

This cleanup branch is not complete.

Current repo state shows:

- `2/6` cleanup-branch items are complete
- `1/6` is partial
- `3/6` are not started

The largest remaining blocker is legacy OpenAI text fallback still being wired into backend startup and still being exported from `@footnote/agent-runtime`. The other open gaps are still structural cleanup work in the Discord bot plus the remaining provider-specific type/error imports there.

## Cleanup Branch Exit Gates And Evidence

### 1. Legacy OpenAI Runtime Deletion

Status: Not Started

Evidence:

- [packages/backend/src/server.ts](/Users/Jordan/Desktop/footnote/packages/backend/src/server.ts) still imports `createLegacyOpenAiRuntime`, constructs `legacyRuntime`, and passes it as `fallbackRuntime` to `createVoltAgentRuntime()`.
- [packages/agent-runtime/src/index.ts](/Users/Jordan/Desktop/footnote/packages/agent-runtime/src/index.ts) still exposes `createLegacyOpenAiRuntime`, still supports `kind: 'legacy-openai'`, and still re-exports the legacy adapter types.
- [packages/agent-runtime/package.json](/Users/Jordan/Desktop/footnote/packages/agent-runtime/package.json) still exports `./legacyOpenAiRuntime`.
- [packages/agent-runtime/test/legacyOpenAiRuntime.test.ts](/Users/Jordan/Desktop/footnote/packages/agent-runtime/test/legacyOpenAiRuntime.test.ts) is still present.

Still needed:

- remove backend startup fallback wiring
- remove the legacy adapter export surface from `@footnote/agent-runtime`
- delete the legacy runtime implementation and its dedicated tests
- re-run parity validation before calling the deletion complete

### 2. Split `packages/discord-bot/src/index.ts`

Status: Not Started

Evidence:

- [packages/discord-bot/src/index.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/index.ts) is still a large entrypoint file at roughly 42 KB.
- Repo search shows provenance and incident interaction handling still living directly in that file, including `report_issue` and provenance action routing.
- The cleanup target is not yet visible as separate interaction-specific modules owned by the entrypoint.

Still needed:

- move image interaction handling into dedicated modules
- move incident modal/report interaction handling into dedicated modules
- move provenance button/detail interaction handling into dedicated modules
- leave `index.ts` as composition and wiring, not the long-term home for interaction logic

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

### 4. `pnpm review` Review Gate

Status: Complete

Evidence:

- [AGENTS.md](/Users/Jordan/Desktop/footnote/AGENTS.md) already lists `pnpm review` under testing and validation guidance.
- [cursor.rules](/Users/Jordan/Desktop/footnote/cursor.rules) already treats `pnpm review` as the standard automated validation step before Cursor review.
- Multiple closeout status docs already use `pnpm review` as part of their validation snapshot, including [2026-03-18-legacy-openai-text-migration-status.md](/Users/Jordan/Desktop/footnote/docs/status/2026-03-18-legacy-openai-text-migration-status.md) and [2026-03-21-legacy-openai-voice-migration-status.md](/Users/Jordan/Desktop/footnote/docs/status/2026-03-21-legacy-openai-voice-migration-status.md).

Still needed:

- keep using `pnpm review` as a required gate on future cleanup-branch work, not just as a documented convention

### 5. Docker Image Validation For Deployable Services

Status: Complete

Evidence:

- [deploy/compose.yml](/Users/Jordan/Desktop/footnote/deploy/compose.yml) defines the backend, web, and bot images.
- [deploy/README.md](/Users/Jordan/Desktop/footnote/deploy/README.md) documents `docker compose -f deploy/compose.yml up --build`.
- `docker compose -f deploy/compose.yml build` was run on 2026-03-25 and completed successfully for `footnote-backend`, `footnote-web`, and `footnote-discord-bot`.

Still needed:

- keep recording image-build results alongside `pnpm review` in future cleanup-branch closeouts

### 6. Optional VoltOps Tracing Enablement

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

- legacy OpenAI text fallback still exists in the active backend wiring
- `discord-bot` entrypoint cleanup is still pending
- `discord-bot` still carries a small but real OpenAI SDK type/error dependency
- optional VoltOps tracing has not been wired yet

## Out Of Scope

This note does not report progress for later workstreams except to mark them as outside this audit. It also does not replace the durable architecture decisions already recorded in:

- [docs/decisions/2026-03-voltagent-runtime-adoption.md](/Users/Jordan/Desktop/footnote/docs/decisions/2026-03-voltagent-runtime-adoption.md)
- [docs/decisions/2026-03-legacy-openai-removal-and-runtime-branching.md](/Users/Jordan/Desktop/footnote/docs/decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)
