# Legacy OpenAI Image Migration Status

## Last Updated

2026-03-18

## Purpose

Track the active branch-level status for moving image generation behind a Footnote-owned image boundary and removing legacy OpenAI-specific product-edge image code.

This file should evolve as the migration moves. The durable architectural direction lives in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)

This file is the working status tracker for the image branch, not the final architecture record.

## Architecture Already Locked

These points are already decided at the architecture level:

- `backend` remains the only public control plane for `web` and `discord-bot`
- image runtime work is part of the same modality-based runtime direction as text, not an exception to it
- `@footnote/agent-runtime` is the default package family for modality-specific runtime adapters unless a later decision establishes a better home
- image does not need to share the text runtime interface and does not need to use VoltAgent directly

## Scope of This Branch

This branch covers image-generation flows and related product-edge provider wiring.

Current examples include:

- Discord image generation commands
- image retries or follow-up generation flows
- image-provider client construction in product-facing modules

In the broader architecture, this branch should become another modality-specific seam in the same runtime package family as text, while keeping image-specific interfaces and lifecycle concerns separate.

This branch does **not** own:

- backend text runtime architecture
- TTS architecture
- realtime voice/session architecture

## Current State

Status: Planned

Known high-level state today:

- image generation still has provider-specific code in product-facing Discord modules
- image-provider client creation is not yet hidden behind a dedicated Footnote-owned boundary
- image generation is still operational, but the architecture is not yet provider-agnostic at the product edge

Likely starting points to track as this branch becomes concrete:

- Discord image session helpers
- Discord image generation pipeline modules
- any image follow-up or retry paths that still depend on provider-specific behavior

Refine the hotspot inventory here as the branch work becomes concrete.

## Target End State

This branch is complete when:

- product-facing image modules no longer construct provider clients directly
- image-provider selection and request shaping live behind a Footnote-owned image boundary
- image generation remains independently evolvable from the text runtime seam
- user-facing image behavior stays Footnote-owned even when provider choice changes underneath

## Working Breakdown

### 1. Image boundary definition

Status: Planned

Track:

- the boundary shape
- what request/response contract it should expose internally
- what image-specific concerns must stay outside provider-native code

### 2. Provider isolation

Status: Planned

Track:

- moving SDK/client construction behind the new boundary
- isolating provider request mapping
- isolating provider response normalization

### 3. Product-flow cutover

Status: Planned

Track:

- Discord image command cutover
- retry/follow-up flow cutover
- any surrounding orchestration that still depends on provider-specific types

### 4. Legacy cleanup

Status: Planned

Track:

- obsolete image helper cleanup
- dead provider-specific product-edge code cleanup
- final removal criteria

## Validation Baseline

Already relevant:

- image command/runtime tests
- any existing image follow-up flow tests
- `pnpm review`

Still to define more precisely for this branch:

- branch-specific regression suite
- acceptance criteria for boundary completeness
- deletion gate checks

## Open Questions

Capture branch-specific questions here as they arise.

Current placeholders:

- What is the smallest useful Footnote-owned image boundary for the first cutover?
- Which image concerns belong inside the boundary versus in Discord orchestration code?
- What parity bar is required before removing product-edge provider construction?

## Notes

- Use this file for current-state updates, branch decisions, and validation snapshots.
- Prefer linking to concrete PRs, tests, and code paths as the work becomes real.
