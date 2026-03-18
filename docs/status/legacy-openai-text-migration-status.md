# Legacy OpenAI Text Migration Status

## Last Updated

2026-03-18

## Purpose

Track the active branch-level status for completing the text migration away from the legacy OpenAI system.

This file should evolve as the migration moves. The durable architectural direction lives in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)
- [VoltAgent Runtime Adoption (Behind the Existing Backend)](../decisions/2026-03-voltagent-runtime-adoption.md)

This file is the working status tracker for the text branch, not the final architecture record.

## Architecture Already Locked

These points are already decided at the architecture level:

- `backend` remains the only public control plane for `web` and `discord-bot`
- `@footnote/agent-runtime` is evolving from a text-first seam into a Footnote-owned home for modality-specific runtime adapters
- text remains the first and most mature migrated slice inside that package family
- provider/framework details must stay behind Footnote-owned boundaries

## Scope of This Branch

This branch covers text-generation flows that should end up behind the backend-owned text runtime path.

Current examples include:

- planner -> generation -> output for reflect
- `/news` and similar text-first command paths

In the broader architecture, this branch is the first migrated modality inside the modality-based runtime package family.

This branch does **not** own:

- image generation architecture
- TTS architecture
- realtime voice/session architecture

## Current State

Status: In progress

Known high-level state today:

- reflect generation already runs through the shared runtime seam
- reflect planning now executes through a backend-local seam backed by the shared runtime
- `/news` still chooses providers locally in Discord
- legacy fallback behavior still exists for parts of the text path

Likely starting points to track as this branch becomes concrete:

- backend planner execution
- runtime parity and fallback behavior
- `/news` text flow

Current concrete hotspots:

- `packages/agent-runtime/src/voltagentRuntime.ts` still falls back to the legacy runtime for search-enabled text requests
- `packages/discord-bot/src/commands/news.ts` still uses local legacy OpenAI text generation
- reflect handler/orchestrator tests now prove planner execution no longer requires the legacy backend service

## Target End State

This branch is complete when:

- text planner and generation no longer split across legacy and new product paths
- tertiary text flows no longer depend on direct legacy `OpenAIService.generateResponse()` calls
- search, citation, and provenance-sensitive behavior are preserved on the new path
- text product flows reach provider/framework code only through Footnote-owned boundaries

## Working Breakdown

### 1. Planner abstraction

Status: In progress

Track:

- how planner execution stops depending on legacy OpenAI-specific calls
- what Footnote-owned abstraction will sit between planner policy and model execution
- what remains owned by `backend` versus what is delegated to the text runtime seam

Current branch status:

- complete for reflect planner execution
- `createReflectPlanner()` now uses a backend-local planner execution seam instead of `OpenAIService.generateResponse()`
- `createReflectOrchestrator()` now executes planner calls through the shared runtime
- `/api/reflect` no longer requires the legacy OpenAI service to run planner logic
- validated by:
  - `packages/backend/test/reflectPlanner.test.ts`
  - `packages/backend/test/reflectOrchestrator.test.ts`
  - `packages/backend/test/reflectHandler.test.ts`

### 2. Runtime parity

Status: Planned

Track:

- search parity
- citation and provenance parity
- fallback removal criteria

Current next focus:

- remove active search fallback from the VoltAgent runtime path
- preserve citations, retrieval facts, and provenance-sensitive metadata behavior

### 3. Tertiary text flows

Status: Planned

Track:

- `/news`
- trusted internal backend text task path for `/news`

### 4. Legacy cleanup

Status: Planned

Track:

- legacy text runtime adapter removal
- dead prompt cleanup
- obsolete helper cleanup

## Validation Baseline

Already relevant:

- reflect planner/runtime tests
- provenance and citation parity tests
- `/news` regression tests
- `pnpm review`

Still to define more precisely for this branch:

- branch-specific test list
- cutover criteria for removing legacy fallback
- final deletion gate checks

Current validation snapshot:

- milestone 1 backend tests passing on 2026-03-18:
  - `pnpm exec tsx --test packages/backend/test/reflectPlanner.test.ts`
  - `pnpm exec tsx --test packages/backend/test/reflectOrchestrator.test.ts`
  - `pnpm exec tsx --test packages/backend/test/reflectHandler.test.ts`

## Open Questions

Capture branch-specific questions here as they arise.

Current placeholders:

- What is the narrowest acceptable parity bar before deleting the legacy text fallback?
- What is the narrowest task contract for `/news` without creating a generic internal text proxy?

## Notes

- Use this file for current-state updates, branch decisions, and validation snapshots.
- Prefer linking to concrete PRs, tests, and code paths as the work becomes real.
- Alternate lens / provenance-lens rewrites are intentionally out of scope for this branch.
