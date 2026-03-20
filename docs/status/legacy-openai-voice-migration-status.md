# Legacy OpenAI Voice Migration Status

## Last Updated

2026-03-20

## Purpose

This note explains the current state of the remaining voice migration work, what is already true in the codebase, and what still needs to move before the legacy OpenAI voice architecture can be considered removed.

The long-term direction still lives in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)

This file is the branch review and current-state summary. It is meant to be easier to read than the decision record, especially for someone joining the work later.

## Current Status

Status: In progress (Checkpoint 2 complete: backend-owned TTS + Discord cutover)

Voice is now the main remaining legacy OpenAI migration branch. Text reflect has already moved behind the backend-owned runtime seam, and image generation has already moved behind a backend-owned image boundary. Voice has not had that cutover yet.

Today, the backend can already choose whether a reflect reply should be plain text or `tts`. That means part of the product decision layer is already backend-owned. The actual speech synthesis now also runs through a backend-owned boundary: the bot calls a trusted internal voice TTS route, and the backend owns the OpenAI adapter and cost recording.

Realtime voice is even less migrated. The active realtime session code still lives in `discord-bot`, still opens the provider websocket directly, still sends provider-native event payloads, and still couples Discord voice orchestration to provider transport behavior.

So the short version is:

- backend owns the decision that a reply may use TTS
- backend owns the TTS execution boundary and provider adapter
- Discord still owns the provider transport for realtime voice
- there is still no backend-owned realtime voice/session boundary comparable to the completed image boundary

## What Changed So Far

The main voice-related progress so far is structural and now includes an active cutover for TTS. In addition to reflect planning already understanding `tts` as a modality, the repo now has a dedicated `@footnote/contracts/voice` surface plus agent-runtime voice seams for both TTS and realtime sessions. Those seams include OpenAI-backed adapters so backend can call voice runtimes without importing provider SDKs directly.

The backend also now exposes `POST /api/internal/voice/tts`, and the Discord bot sends TTS requests there instead of calling the provider directly. That keeps speech synthesis and cost tracking in the backend while Discord only handles delivery.

What has not changed yet is realtime execution ownership. The Discord bot still uses its local realtime service, websocket, audio handler, and session wiring. That means realtime voice still behaves like the old product-edge OpenAI design even though text, image, and now TTS no longer do.

## Decisions That Matter

The architectural direction is already settled even though the branch is not implemented yet.

Voice should follow the same broad ownership model as text and image: `backend` remains the public control plane, Footnote-owned contracts stay outside provider code, and provider-specific voice behavior moves behind a Footnote-owned internal boundary.

At the same time, voice does not need to copy the text runtime exactly. The project has already decided that TTS and realtime voice do not need to share one seam, and they do not need to use VoltAgent. The important requirement is not framework uniformity. The requirement is that product-facing modules stop calling provider APIs directly.

That means the likely end state is:

- one Footnote-owned TTS boundary
- one Footnote-owned realtime voice/session boundary
- Discord continues to own user-facing orchestration, capture, playback, and presentation
- provider SDK and websocket details move behind backend-owned or runtime-owned voice adapters

## Final Architecture in Plain Language

The target architecture is straightforward to describe even though it is not built yet.

A Discord message or command that needs speech output should ask backend for voice work through a Footnote-owned boundary. Backend should own the trusted request contract, execution entrypoint, and any normalized voice result shape. A voice runtime adapter should own provider-specific request mapping underneath that boundary. Discord should keep the user-facing pieces such as message orchestration, attachment delivery, audio playback, and voice-channel interaction flow.

Realtime voice should follow the same ownership story. Discord should still manage Discord voice connections and local audio capture or playback, but it should no longer own direct provider websocket setup, provider-native event creation, or provider-native session lifecycle semantics. Those should move behind a Footnote-owned voice/session seam.

That would give voice the same kind of ownership story image now has: backend owns the control-plane boundary, runtime adapters own provider-specific behavior, and Discord owns the user-facing experience.

## What Still Needs To Happen

There are four main pieces of remaining work.

First, the project needs the backend-owned realtime voice/session boundary. The runtime seam exists, but Discord still opens the OpenAI realtime websocket directly, still sends provider-native `session.update`, `conversation.item.create`, and audio-buffer events, and still couples voice orchestration to those transport details.

Second, after realtime boundaries exist and are in use, the branch can do the normal cleanup work: narrow or remove remaining Discord-local voice helpers, remove direct provider transport wiring from voice flows, and define the final deletion gate clearly.

## What Stayed Out of Scope So Far

This branch has not started implementation yet, so most scope questions are still about what not to mix in.

The voice migration should not turn into a redesign of backend text runtime work. It also should not reopen the completed image branch. And it should not force TTS and realtime voice into one abstraction if that makes the design worse. The point of this branch is ownership cleanup and boundary correction, not uniformity for its own sake.

## Validation Snapshot

There is already useful voice-related test coverage, but it mostly validates the current Discord-local implementation rather than a future backend-owned voice boundary.

The repo already has tests around:

- Discord-local TTS usage recording
- temporary TTS file cleanup
- realtime audio commit and speaker annotation behavior
- voice-session forwarding behavior
- audio playback concurrency
- realtime audio resampling
- realtime engagement scoring

That is a good starting point, but it is not yet the final migration proof. The branch will still need backend-owned voice contract tests, runtime adapter tests, and cutover tests that prove product-facing voice modules no longer call provider APIs directly.

The broader validation expectations remain the usual ones for this repo:

- `pnpm lint-check`
- `pnpm review`
- `pnpm validate-footnote-tags`
- `pnpm validate-openapi-links`

## Deletion Gate Result

The deletion gate is not yet satisfied for voice.

Reflect TTS now uses the backend-owned internal voice route. Realtime voice still uses Discord-local provider websocket transport, and the backend-owned realtime voice runtime seam is not yet wired end-to-end.

In short, the voice branch is still the remaining legacy OpenAI product-edge architecture. The migration direction is now much clearer because text and image already established the ownership pattern, but the actual voice cutover work still needs to be done.
