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
- tertiary text flows such as provenance-lens rewrites
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
- planner work is not fully migrated
- some Discord-side tertiary text flows still choose providers locally
- legacy fallback behavior still exists for parts of the text path

Likely starting points to track as this branch becomes concrete:

- backend planner execution
- runtime parity and fallback behavior
- provenance-lens and `/news` text flows

The exact hotspot inventory should be updated here as the migration work is refined.

## Target End State

This branch is complete when:

- text planner and generation no longer split across legacy and new product paths
- tertiary text flows no longer depend on direct legacy `OpenAIService.generateResponse()` calls
- search, citation, and provenance-sensitive behavior are preserved on the new path
- text product flows reach provider/framework code only through Footnote-owned boundaries

## Working Breakdown

### 1. Planner abstraction

Status: Planned

Track:

- how planner execution stops depending on legacy OpenAI-specific calls
- what Footnote-owned abstraction will sit between planner policy and model execution
- what remains owned by `backend` versus what is delegated to the text runtime seam

### 2. Runtime parity

Status: Planned

Track:

- search parity
- citation and provenance parity
- fallback removal criteria

### 3. Tertiary text flows

Status: Planned

Track:

- provenance-lens flows
- `/news`
- any other Discord-side text flows that still choose providers locally

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
- provenance-lens regression tests
- `pnpm review`

Still to define more precisely for this branch:

- branch-specific test list
- cutover criteria for removing legacy fallback
- final deletion gate checks

## Open Questions

Capture branch-specific questions here as they arise.

Current placeholders:

- Which Footnote-owned planner abstraction will be simplest without overfitting to VoltAgent?
- Which tertiary text flows should route through backend versus a shared internal text helper?
- What is the narrowest acceptable parity bar before deleting the legacy text fallback?

## Notes

- Use this file for current-state updates, branch decisions, and validation snapshots.
- Prefer linking to concrete PRs, tests, and code paths as the work becomes real.
