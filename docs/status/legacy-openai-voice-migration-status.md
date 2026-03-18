# Legacy OpenAI Voice Migration Status

## Last Updated

2026-03-18

## Purpose

Track the active branch-level status for moving TTS and realtime voice behind Footnote-owned voice boundaries and removing legacy OpenAI-specific product-edge voice code.

This file should evolve as the migration moves. The durable architectural direction lives in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)

This file is the working status tracker for the voice branch, not the final architecture record.

## Architecture Already Locked

These points are already decided at the architecture level:

- `backend` remains the only public control plane for `web` and `discord-bot`
- voice runtime work is part of the same modality-based runtime direction as text and image, not a side system
- `@footnote/agent-runtime` is the default package family for modality-specific runtime adapters unless a later decision establishes a better home
- voice does not need to share the text runtime interface and does not need to use VoltAgent directly
- TTS and realtime may share helpers, but they are not required to share one seam

## Scope of This Branch

This branch covers:

- text-to-speech
- realtime voice/session transport
- product-edge provider wiring for voice flows

In the broader architecture, this branch should become modality-specific runtime work in the same package family as text and image, while keeping voice/session interfaces separate from text-style request/response contracts.

This branch does **not** own:

- backend text runtime architecture
- image generation architecture

## Current State

Status: Planned

Known high-level state today:

- TTS still routes through legacy provider-specific code paths
- realtime voice/session code still talks directly to provider transport APIs
- voice capability exists, but the architecture is not yet isolated behind Footnote-owned boundaries

Likely starting points to track as this branch becomes concrete:

- reflect TTS entrypoints
- realtime voice/session service and websocket transport code
- any voice orchestration that still depends on provider-native behavior

Refine the hotspot inventory here as the branch work becomes concrete.

## Target End State

This branch is complete when:

- TTS reaches provider/framework code only through a Footnote-owned TTS boundary
- realtime voice/session code reaches provider/framework code only through a Footnote-owned voice/session boundary
- product-facing voice modules no longer connect directly to provider APIs
- Footnote-owned consent, engagement, and runtime-control semantics remain outside provider-native code

## Working Breakdown

### 1. TTS boundary

Status: Planned

Track:

- the internal TTS boundary shape
- what TTS request/response contract should look like
- what user-facing speech behavior remains owned outside provider-native code

### 2. Realtime voice/session boundary

Status: Planned

Track:

- the realtime/session boundary shape
- transport ownership
- audio/session lifecycle responsibilities

### 3. Product-flow cutover

Status: Planned

Track:

- reflect TTS cutover
- realtime voice/session cutover
- any surrounding orchestration that still depends on provider-native behavior

### 4. Legacy cleanup

Status: Planned

Track:

- obsolete voice helper cleanup
- direct transport/API cleanup
- final removal criteria

## Validation Baseline

Already relevant:

- TTS regression tests
- realtime voice/session regression tests
- `pnpm review`

Still to define more precisely for this branch:

- branch-specific regression suite
- cutover acceptance criteria
- deletion gate checks

## Open Questions

Capture branch-specific questions here as they arise.

Current placeholders:

- Should TTS and realtime share any helper layer, or stay fully separate?
- What is the smallest useful realtime boundary that still keeps transport/provider details out of product-facing modules?
- What parity bar is required before removing direct provider transport calls?

## Notes

- Use this file for current-state updates, branch decisions, and validation snapshots.
- Prefer linking to concrete PRs, tests, and code paths as the work becomes real.
