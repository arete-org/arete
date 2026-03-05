# TRACE Work Log (Temporary)

## Scope

- Branch: `feat/TRACE-UI`
- Decision reference: `docs/decisions/2026-04-compact-provenance-TRACE.md`
- Purpose of this temp doc: track implementation progress while TRACE is still being explored.
- Current phase: Step 3 (isolated Discord `/trace-preview` SVG experiment).

## Inventory

- Canonical response metadata currently lives in `packages/contracts/src/ethics-core/types.ts` as `ResponseMetadata` and now includes optional `temperament`.
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
- Rollout requirement status: `temperament` is optional for now, but intended to become required after full implementation and validation.
- TODO(TRACE-rollout): make `temperament` required after cross-surface implementation and validation.
- Source of values: model-emitted metadata + backend validation/defaulting (fail-open).
- API scope for this branch: update contracts + schemas + OpenAPI now.
- CGI experiment path: isolated Discord command (`/trace-preview`) and not integrated into production provenance footer yet.
- Experiment access: developer-only.
- Render format for first experiment pass: SVG only (PNG deferred).
- Preview input mode for first experiment pass: manual command args.

## Work Log

- Created `docs/temp-TRACE.md` (this doc).
- Completed baseline inventory pass across contracts, backend reflect/trace flow, and Discord provenance flow.
- Confirmed existing targeted test baseline passes for contracts/backend/discord provenance-related paths.
- Step 2 contract/schema work started.
- Added `ResponseTemperament` type and optional `temperament` field to shared ethics-core metadata contracts.
- Added runtime schema validation for `temperament` axes (integers 1..10) in web contract schemas.
- Updated OpenAPI `ResponseMetadataBase` schema to document optional `temperament`.
- Added contract tests for valid/invalid `temperament` payloads.
- Added explicit TRACE axis semantics + TODO rollout labels in contracts/OpenAPI.
- Step 3 command/renderer implementation started.
- Added isolated `/trace-preview` developer-only command for manual TRACE experiments.
- Added SVG renderer utility for TRACE wheel + chip composition.
- Added renderer unit tests and verified bot build compatibility.
- Added JSDoc coverage pass across Step 3 preview command/renderer helpers (targeting >=80% documented symbols in new TRACE experiment code).
- Added follow-up JSDoc on `TracePreviewChipData` to close remaining obvious doc gap in Step 3 renderer types.
- Completed junior-friendliness/readability pass across TRACE contracts, schemas, OpenAPI docs, and Step 3 command/renderer code.
- Added `TraceAxisScore` (`1..10`) type to enforce TRACE axis range for typed literals in TypeScript.
- Added explicit notes where runtime schema validation is still required for dynamic payloads.
- Standardized TRACE axis wording across contracts, schema comments, OpenAPI descriptions, and slash-command option text.
- Added renderer section comments (wheel geometry, band fill math, chip layout) to reduce cognitive load for future edits.
- Refined TRACE axis type docs so `TraceAxisScore` and `ResponseTemperament` are documented side-by-side in contracts for clearer readability.
- Reordered imports in TRACE preview command/renderer so `ResponseTemperament` and `TraceAxisScore` appear together.
- Replaced placeholder comment in `trace-preview.ts` with JSDoc on the command definition for clearer junior-facing intent.

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
- Step 2 validations:
    - `pnpm exec tsx --test packages/contracts/test/webSchemas.test.ts` (pass)
    - `pnpm validate-openapi-links` (pass)
    - `pnpm lint-check` (pass)
- Step 3 validations:
    - `pnpm exec tsx --test packages/discord-bot/test/tracePreviewSvg.test.ts packages/contracts/test/webSchemas.test.ts` (pass)
    - `pnpm --filter @footnote/discord-bot build` (pass)
    - `pnpm lint-check` (pass)
    - Re-ran full Step 3 validation suite after JSDoc pass (all pass).
    - Re-ran `pnpm lint-check` after final JSDoc follow-up (pass).
    - Readability pass validations:
        - `pnpm exec tsx --test packages/discord-bot/test/tracePreviewSvg.test.ts packages/contracts/test/webSchemas.test.ts` (pass)
        - `pnpm --filter @footnote/discord-bot build` (pass)
        - `pnpm lint-check` (pass)

## Step 3 Status

- Goal: experiment with TRACE CGI in Discord without touching production provenance footer flow.
- Implemented:
    - Added SVG renderer utility: `packages/discord-bot/src/utils/tracePreview/tracePreviewSvg.ts`
    - Added developer-only slash command: `packages/discord-bot/src/commands/trace-preview.ts`
    - Added renderer tests: `packages/discord-bot/test/tracePreviewSvg.test.ts`
    - Kept production provenance footer path unchanged.
