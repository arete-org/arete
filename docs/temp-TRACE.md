# TRACE Work Log (Temporary)

## Scope
- Branch: `feat/TRACE-UI`
- Decision reference: `docs/decisions/2026-04-compact-provenance-TRACE.md`
- Purpose of this temp doc: track implementation progress while TRACE is still being explored.
- Current phase: Step 1 (create and initialize working progress document).

## Inventory
- Canonical response metadata currently lives in `packages/contracts/src/ethics-core/types.ts` as `ResponseMetadata` (no TRACE/temperament field yet).
- Runtime schema validation currently lives in `packages/contracts/src/web/schemas.ts`.
- Backend reflect metadata build/store flow currently lives in:
  - `packages/backend/src/services/openaiService.ts`
  - `packages/backend/src/services/reflectService.ts`
  - `packages/backend/src/handlers/trace.ts`
  - `packages/backend/src/storage/traces/sqliteTraceStore.ts`
- Discord provenance footer is currently text/embed based in:
  - `packages/discord-bot/src/utils/response/provenanceFooter.ts`
  - `packages/discord-bot/src/utils/response/provenanceInteractions.ts`
- No existing image rendering dependency (canvas/sharp/skia) is currently wired for bot/backend provenance rendering.

## Decisions
- Canonical TRACE field name: `temperament`.
- Canonical shape: named keys (`tightness`, `rationale`, `attribution`, `caution`, `extent`).
- Canonical numeric granularity: integers `1..10`.
- Source of values: model-emitted metadata + backend validation/defaulting (fail-open).
- API scope for this branch: update contracts + schemas + OpenAPI now.
- CGI experiment path: isolated Discord command (`/trace-preview`) and not integrated into production provenance footer yet.
- Experiment access: developer-only.
- Render format for first experiment pass: SVG only (PNG deferred).
- Preview input mode for first experiment pass: manual command args.

## Work Log
- 2026-03-04: Created `docs/temp-TRACE.md`.
- 2026-03-04: Completed baseline inventory pass across contracts, backend reflect/trace flow, and Discord provenance flow.
- 2026-03-04: Confirmed existing targeted test baseline passes for contracts/backend/discord provenance-related paths.

## Open Questions
- No blocking open questions for Step 1.
- Pending later implementation detail: exact default temperament object used when model metadata is missing/invalid (proposed neutral default is `5` per axis).

## Experiment Notes
- Experiment is intentionally isolated from `buildFooterEmbed` production path.
- `responseId` parsing in provenance actions currently depends on embed footer text and should remain unchanged during isolated CGI experimentation.

## Validation Results
- Baseline tests executed before implementation planning:
  - `packages/contracts/test/webSchemas.test.ts`
  - `packages/backend/test/traceStoreUtilsValidation.test.ts`
  - `packages/backend/test/traceStore.test.ts`
  - `packages/backend/test/reflectService.test.ts`
  - `packages/discord-bot/test/messageProcessor.reflect.test.ts`
- Result: all passed at planning time.
