# TRACE Work Log (Temporary)

## Scope

- Branch: `feat/TRACE-UI`
- Decision reference: `docs/decisions/2026-04-compact-provenance-TRACE.md`
- Purpose of this temp doc: track implementation progress while TRACE is still being explored.
- Current phase: Step 4 closeout (TRACE schema/type alignment + documentation sync).

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
- Trace-card rendering now uses backend-owned SVG generation plus PNG conversion via `@resvg/resvg-js`.

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
- Render flow: backend stores canonical SVG and returns PNG payloads where Discord-style delivery is needed.
- Preview input modes: manual payload (`POST /api/trace-cards`) and from-stored-trace (`POST /api/trace-cards/from-trace`).

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
- Implemented Step 4 backend-owned trace-card flow:
    - Added contracts/OpenAPI for `POST /api/trace-cards` and `GET /api/traces/{responseId}/assets/trace-card.svg`.
    - Added backend canonical TRACE card renderer (SVG) and SVG-to-PNG conversion utility.
    - Added SQLite `provenance_trace_cards` storage and trace-store read/write methods.
    - Added backend trace-card create/read handlers and server route wiring.
    - Added best-effort trace-card persistence during normal trace metadata writes when `temperament` is present.
    - Updated Discord `/trace-preview` to call backend `POST /api/trace-cards` and attach `trace-card.png`.
    - Removed bot-local duplicate TRACE SVG renderer/test path to keep backend as single rendering owner.
    - Simplified trace-card generation intent split:
        - `POST /api/trace-cards` remains manual-input preview flow.
        - `POST /api/trace-cards/from-trace` now generates from stored trace metadata by `responseId`.
    - Simplified server-side behavior for from-trace generation by deriving chips from stored metadata (no client chip overrides).
    - Reduced backend handler complexity by extracting shared trace write access/body parsing helpers.
- Completed closeout schema/type alignment:
    - Added literal TRACE axis schema (`1..10`) so Zod output aligns with `TraceAxisScore`/`ResponseTemperament`.
    - Added compile-oriented contract compatibility checks for reflect and trace validator output types.

## Open Questions

- No blocking open questions.
- Pending later implementation detail: exact default temperament object used when model metadata is missing/invalid (proposed neutral default is `5` per axis).

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
    - Isolated preview command + renderer path passed during experimentation.
- Startup/dev validation passed at a high level:
    - Bot contract schema export resolution works under `tsx`.
    - `start:all` launches backend/web/bot with preflight cleanup and stable startup behavior.
- Step 4 validation passed:
    - Contracts TRACE card schema tests pass.
    - Backend trace-card renderer, storage, and handler tests pass.
    - OpenAPI link validation passes with new trace-card operations.
    - Discord bot trace API tests pass after backend trace-card integration.
    - Backend from-trace route tests pass (success + missing temperament conflict).
    - Discord bot build passes with `/trace-preview` backend render flow.
- Closeout validation status:
    - TRACE schema output now aligns with shared `ResponseTemperament` typing, resolving the prior web typecheck mismatch.

## Step 3 Status

- Goal: experiment with TRACE CGI in Discord without touching production provenance footer flow.
- Implemented:
    - Added developer-only slash command: `packages/discord-bot/src/commands/trace-preview.ts`
    - Kept production provenance footer path unchanged.
    - Step 3 local SVG renderer path has now been superseded by Step 4 backend-owned trace-card rendering.
