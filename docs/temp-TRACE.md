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

- Created this temp tracker and completed a baseline inventory of contracts, backend trace/reflect flow, and Discord provenance flow.
- Implemented Step 2 TRACE contract surface:
    - Added optional `temperament` to shared metadata contracts.
    - Added runtime schema validation for all five axes (`1..10` integers).
    - Updated OpenAPI docs to include TRACE metadata and axis meaning.
    - Added TODO rollout labeling that TRACE is optional now and intended to become required later.
- Implemented Step 3 isolated CGI experiment surface:
    - Added developer-only `/trace-preview` command.
    - Added SVG renderer utility for the TRACE wheel/chip preview.
    - Kept production provenance footer flow unchanged.
- Strengthened type/docs/readability for TRACE:
    - Added `TraceAxisScore` type and aligned axis wording across contracts/schema/OpenAPI/command text.
    - Added junior-friendly comments/JSDoc coverage across new TRACE files.
    - Kept runtime validation notes explicit where TypeScript alone cannot guarantee payload safety.
- Stabilized local multi-service startup:
    - Fixed bot-side contracts schema resolution under `tsx`.
    - Added dev-safe prebuild paths and consolidated root startup commands (`start:web`, `start:all`).
    - Added cross-platform preflight port cleanup (using `.env` ports), improved Ctrl+C teardown behavior, and reduced debugger/noise interference.
    - Resolved duplicate bot handling by hardening stale bot process cleanup before launch.

## Open Questions

- No blocking open questions for Step 1.
- Pending later implementation detail: exact default temperament object used when model metadata is missing/invalid (proposed neutral default is `5` per axis).
- TODO(TRACE-types): `packages/web/src/utils/api.ts` currently has type mismatch against `ResponseTemperament` after introducing `TraceAxisScore` literal union; needs follow-up typing alignment between Zod schema output and shared contract types.

## Experiment Notes

- Experiment is intentionally isolated from `buildFooterEmbed` production path.
- `responseId` parsing in provenance actions currently depends on embed footer text and should remain unchanged during isolated CGI experimentation.

## Validation Results

- Baseline inventory validation passed across existing contracts/backend/discord provenance tests before TRACE changes.
- Step 2 validation passed:
    - Contracts TRACE schema tests pass.
    - OpenAPI link validation passes.
    - Lint passes.
- Step 3 validation passed:
    - TRACE preview renderer tests pass.
    - Discord bot build passes.
    - Lint passes after JSDoc/readability updates.
- Startup/dev validation passed at a high level:
    - Bot contract schema export resolution works under `tsx`.
    - `start:all` launches backend/web/bot with preflight cleanup and stable startup behavior.
- Current known follow-up gap:
    - `pnpm --filter @footnote/web exec tsc --noEmit -p tsconfig.json` still reports a `ResponseTemperament` vs schema-output typing mismatch in `packages/web/src/utils/api.ts`.

## Step 3 Status

- Goal: experiment with TRACE CGI in Discord without touching production provenance footer flow.
- Implemented:
    - Added SVG renderer utility: `packages/discord-bot/src/utils/tracePreview/tracePreviewSvg.ts`
    - Added developer-only slash command: `packages/discord-bot/src/commands/trace-preview.ts`
    - Added renderer tests: `packages/discord-bot/test/tracePreviewSvg.test.ts`
    - Kept production provenance footer path unchanged.
