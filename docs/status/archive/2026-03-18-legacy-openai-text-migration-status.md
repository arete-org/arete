# Legacy OpenAI Text Migration Status

## Last Updated

2026-03-18

## Purpose

Track branch-level status for completing the text migration away from the legacy OpenAI system.

This file records current state and validation. The durable architecture decisions live in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)
- [VoltAgent Runtime Adoption (Behind the Existing Backend)](../../decisions/2026-03-voltagent-runtime-adoption.md)

## Scope

This branch covered the text flows that now belong behind the backend-owned text runtime path:

- reflect planner -> generation -> output
- `/news`

Out of scope:

- image generation
- TTS
- realtime voice/session work
- alternate lens / provenance-lens rewrite work

## Status

Status: Complete for current branch scope

### Exit Gates Met

- reflect planning no longer depends on legacy `OpenAIService.generateResponse()`
- active reflect retrieval no longer depends on legacy fallback runtime
- `/news` no longer uses local legacy generation
- in-scope text product flows now reach provider/framework code only through Footnote-owned boundaries

### Final State

- reflect generation already runs through the shared runtime seam
- reflect planning now executes through a backend-local planner seam backed by the shared runtime
- VoltAgent text runtime now handles search-enabled reflect requests directly in the active text path
- `/news` now runs through a backend-owned internal task path instead of choosing providers locally in Discord
- trusted internal backend text task infrastructure now exists for the `news` task
- any remaining legacy OpenAI helpers now belong to out-of-scope branches such as image, voice, or alternate lens overhaul work

## Completed Work

### 1. Planner Abstraction

Status: Complete

- `createReflectPlanner()` now uses a backend-local planner execution seam instead of `OpenAIService.generateResponse()`
- `createReflectOrchestrator()` now executes planner calls through the shared runtime
- `/api/reflect` no longer requires the legacy OpenAI service to run planner logic

Validated by:

- `packages/backend/test/reflectPlanner.test.ts`
- `packages/backend/test/reflectOrchestrator.test.ts`
- `packages/backend/test/reflectHandler.test.ts`

### 2. Runtime Parity

Status: Complete

- VoltAgent runtime no longer delegates search-enabled generation to the legacy runtime in the active text path
- retrieved replies now normalize back into Footnote citations, retrieval facts, and retrieved provenance
- markdown-link citation recovery is preserved for retrieval-backed replies that lack structured source records
- backend reflect request building now strips blank search queries before they reach the shared runtime

Validated by:

- `packages/agent-runtime/test/voltagentRuntime.test.ts`
- `packages/backend/test/reflectService.test.ts`

### 3. `/news` Cutover

Status: Complete

- backend now owns the internal `news` task endpoint at `/api/internal/text`
- trusted callers can post `task: 'news'` to that endpoint
- backend owns prompt assembly, runtime execution, structured parsing, and response validation for the task
- Discord now uses a narrow internal news-task API client method for `/news`
- `/news` no longer uses local legacy generation
- milestone cleanup narrowed the implementation naming around `news`
- the unused `allowedDomains` request field was removed
- trusted handler auth/body parsing now uses shared backend helpers
- `/news` command tests now verify the bot calls `runNewsTaskViaApi()` and renders the backend-owned result shape

Validated by:

- `packages/contracts/test/webSchemas.test.ts`
- `packages/backend/test/internalTextHandler.test.ts`
- `packages/discord-bot/test/api.internalText.test.ts`
- `packages/discord-bot/test/newsCommand.test.ts`

### 4. Legacy Cleanup

Status: Complete for current branch scope

- active legacy text-path usage is removed for reflect planning/runtime and `/news`
- dead text-path prompt and contract naming was cleaned up where it affected the migrated flow
- remaining legacy helpers are no longer part of the active text path for this branch

## Validation Snapshot

Passing on 2026-03-18:

- `pnpm exec tsx --test packages/backend/test/reflectPlanner.test.ts`
- `pnpm exec tsx --test packages/backend/test/reflectOrchestrator.test.ts`
- `pnpm exec tsx --test packages/backend/test/reflectHandler.test.ts`
- `pnpm exec tsx --test packages/agent-runtime/test/voltagentRuntime.test.ts`
- `pnpm exec tsx --test packages/backend/test/reflectService.test.ts`
- `pnpm exec tsx --test packages/contracts/test/webSchemas.test.ts`
- `pnpm exec tsx --test packages/backend/test/internalTextHandler.test.ts`
- `pnpm exec tsx --test packages/discord-bot/test/api.internalText.test.ts`
- `pnpm exec tsx --test packages/discord-bot/test/newsCommand.test.ts`
- `pnpm review`

## Notes

- This status file is a closeout snapshot for the text branch scope, not a new architecture decision.
- Follow-on removal work for image, voice, and alternate lens flows belongs in their own branch/status tracking.
