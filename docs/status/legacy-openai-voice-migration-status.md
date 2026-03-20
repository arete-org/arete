# Legacy OpenAI Voice Migration Status

## Last Updated

2026-03-20

## Purpose

This note explains the current state of the remaining voice migration work, what is already true in the codebase, and what still needs to move before the legacy OpenAI voice architecture can be considered removed.

The long-term direction still lives in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)

This file is the branch review and current-state summary. It is meant to be easier to read than the decision record, especially for someone joining the work later.

## Current Status

Status: In progress (Checkpoint 2 complete: Discord realtime seam cleanup)

Voice is now the main remaining legacy OpenAI migration branch. Text reflect has already moved behind the backend-owned runtime seam, and image generation has already moved behind a backend-owned image boundary. Voice now has both TTS and realtime running through backend-owned boundaries, and the Discord realtime layer has been cleaned up to match that boundary more closely. What remains is deletion-gate proof and final branch closeout validation.

Today, the backend can already choose whether a reflect reply should be plain text or `tts`. That means part of the product decision layer is already backend-owned. The actual speech synthesis now also runs through a backend-owned boundary: the bot calls a trusted internal voice TTS route, and the backend owns the OpenAI adapter and cost recording.

Realtime voice is now also routed through a backend-owned boundary. Discord opens a trusted internal websocket to `/api/internal/voice/realtime`, and the backend owns the provider websocket, session lifecycle, and prompt assembly. The Discord bot still owns the voice UX, but it no longer talks to the provider directly.

So the short version is:

- backend owns the decision that a reply may use TTS
- backend owns the TTS execution boundary and provider adapter
- backend owns the realtime voice/session boundary and provider transport
- Discord owns user-facing orchestration and audio capture/playback, not provider sessions

## What Changed So Far

The main voice-related progress so far is structural and now includes active cutovers for both TTS and realtime. In addition to reflect planning already understanding `tts` as a modality, the repo now has a dedicated `@footnote/contracts/voice` surface plus agent-runtime voice seams for both TTS and realtime sessions. Those seams include OpenAI-backed adapters so backend can call voice runtimes without importing provider SDKs directly.

The backend also now exposes `POST /api/internal/voice/tts`, and the Discord bot sends TTS requests there instead of calling the provider directly. That keeps speech synthesis and cost tracking in the backend while Discord only handles delivery.

The backend now also exposes `GET /api/internal/voice/realtime` for trusted websocket sessions. The Discord bot connects there, and the backend owns the realtime prompt composition, provider websocket wiring, and session lifecycle. Discord still drives the user-facing voice flow, but the provider transport is now backend-owned.

## Decisions That Matter

The architectural direction is settled, and the core cutovers now follow it.

Voice should follow the same broad ownership model as text and image: `backend` remains the public control plane, Footnote-owned contracts stay outside provider code, and provider-specific voice behavior moves behind a Footnote-owned internal boundary.

At the same time, voice does not need to copy the text runtime exactly. The project has already decided that TTS and realtime voice do not need to share one seam, and they do not need to use VoltAgent. The important requirement is not framework uniformity. The requirement is that product-facing modules stop calling provider APIs directly.

That means the likely end state is:

- one Footnote-owned TTS boundary
- one Footnote-owned realtime voice/session boundary
- Discord continues to own user-facing orchestration, capture, playback, and presentation
- provider SDK and websocket details move behind backend-owned or runtime-owned voice adapters

## Final Architecture in Plain Language

The target architecture is now largely built and easier to describe.

A Discord message or command that needs speech output should ask backend for voice work through a Footnote-owned boundary. Backend should own the trusted request contract, execution entrypoint, and any normalized voice result shape. A voice runtime adapter should own provider-specific request mapping underneath that boundary. Discord should keep the user-facing pieces such as message orchestration, attachment delivery, audio playback, and voice-channel interaction flow.

Realtime voice should follow the same ownership story. Discord should still manage Discord voice connections and local audio capture or playback, but it should no longer own direct provider websocket setup, provider-native event creation, or provider-native session lifecycle semantics. Those should move behind a Footnote-owned voice/session seam. That boundary now exists, and the remaining work is cleanup and validation.

That gives voice the same kind of ownership story image now has: backend owns the control-plane boundary, runtime adapters own provider-specific behavior, and Discord owns the user-facing experience.

## What Still Needs To Happen

There is one main piece of branch work left after the correctness and Discord seam cleanup passes.

- define and verify the deletion gate clearly: confirm there are no remaining voice flows (TTS or realtime) that call provider APIs directly, and remove any legacy code paths that would still allow that if discovered during validation

## What Stayed Out of Scope So Far

Even after the cutovers, the branch intentionally avoided mixing in broader refactors so the ownership change stayed easy to validate.

The voice migration should not turn into a redesign of backend text runtime work. It also should not reopen the completed image branch. And it should not force TTS and realtime voice into one abstraction if that makes the design worse. The point of this branch is ownership cleanup and boundary correction, not uniformity for its own sake.

## Validation Snapshot

There is already useful voice-related test coverage, and the first two checkpoints added focused coverage for both the backend/runtime realtime seam and the cleaned-up Discord event mapping. The branch still needs explicit deletion-gate proof before final closeout.

The repo already has tests around:

- TTS usage recording
- temporary TTS file cleanup
- realtime audio commit and speaker annotation behavior
- voice-session forwarding behavior
- audio playback concurrency
- realtime audio resampling
- realtime engagement scoring
- realtime `session.ready` replay for late listeners
- internal realtime websocket upgrade rejection at the backend boundary
- Discord-side mapping of backend realtime audio/text/completion events

That is a good starting point, but it is not yet the final migration proof. The branch still needs focused tests (or assertions) that prove product-facing voice modules no longer call provider APIs directly.

The broader validation expectations remain the usual ones for this repo:

- `pnpm lint-check`
- `pnpm review`
- `pnpm validate-footnote-tags`
- `pnpm validate-openapi-links`

## Deletion Gate Result

The deletion gate is not yet satisfied for voice, but the branch is validation-clean and structurally close to the final state.

Reflect TTS now uses the backend-owned internal voice route. Realtime voice now uses the backend-owned websocket boundary instead of a Discord-local provider socket. `pnpm review` is green again, the upgrade-socket typing issue is fixed, the realtime runtime replays `session.ready` for listeners that subscribe after session creation, and the Discord realtime layer no longer carries the old `audio_collected` compatibility path or stale event typing. The remaining work is to prove, via tests and validation, that no product-facing voice path still calls provider APIs directly.

In short, the core cutover is in place, the realtime seam is cleaned up, and deletion-gate verification is the final remaining step before the legacy voice architecture can be removed.
