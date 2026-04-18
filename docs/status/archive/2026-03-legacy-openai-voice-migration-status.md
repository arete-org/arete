# Legacy OpenAI Voice Migration Status

## Last Updated

2026-03-21

## Purpose

This note explains how the voice migration landed, what is now true in the codebase, and what final branch state was reached before the legacy OpenAI voice architecture was considered removed from product-facing voice flows.

The long-term direction still lives in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)

This file is the branch review and current-state summary. It is meant to be easier to read than the decision record, especially for someone joining the work later.

## Current Status

Status: Complete (deletion gate satisfied)

Voice was the main remaining legacy OpenAI migration branch. Text reflect has already moved behind the backend-owned runtime seam, and image generation has already moved behind a backend-owned image boundary. Voice now also has both TTS and realtime running through backend-owned boundaries, and the deletion gate for product-facing voice paths is now satisfied.

The backend can already choose whether a reflect reply should be plain text or `tts`. That means part of the product decision layer is already backend-owned. The actual speech synthesis now also runs through a backend-owned boundary: the bot calls a trusted internal voice TTS route, and the backend owns the OpenAI adapter and cost recording.

Realtime voice is now also routed through a backend-owned boundary. Discord opens a trusted internal websocket to `/api/internal/voice/realtime`, and the backend owns the provider websocket, session lifecycle, and prompt assembly. The Discord bot still owns the voice UX, but it no longer talks to the provider directly.

So the short version is:

- backend owns the decision that a reply may use TTS
- backend owns the TTS execution boundary and provider adapter
- backend owns the realtime voice/session boundary and provider transport
- Discord owns user-facing orchestration and audio capture/playback, not provider sessions

## What Changed

The main voice-related progress was structural and included active cutovers for both TTS and realtime. In addition to reflect planning already understanding `tts` as a modality, the repo now has a dedicated `@footnote/contracts/voice` surface plus agent-runtime voice seams for both TTS and realtime sessions. Those seams include OpenAI-backed adapters so backend can call voice runtimes without importing provider SDKs directly.

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

## Final Architecture In Plain Language

The target architecture is now built and easier to describe.

A Discord message or command that needs speech output should ask backend for voice work through a Footnote-owned boundary. Backend should own the trusted request contract, execution entrypoint, and any normalized voice result shape. A voice runtime adapter should own provider-specific request mapping underneath that boundary. Discord should keep the user-facing pieces such as message orchestration, attachment delivery, audio playback, and voice-channel interaction flow.

Realtime voice should follow the same ownership story. Discord should still manage Discord voice connections and local audio capture or playback, but it should no longer own direct provider websocket setup, provider-native event creation, or provider-native session lifecycle semantics. Those concerns now sit behind a Footnote-owned voice/session seam that is active in the product.

That gives voice the same kind of ownership story image now has: backend owns the control-plane boundary, runtime adapters own provider-specific behavior, and Discord owns the user-facing experience.

## What Still Needs To Happen

The branch work described in this note is complete.

The deletion gate is now defined and verified: product-facing Discord voice paths use Footnote-owned backend routes or websocket boundaries, and the remaining provider-specific voice code lives behind backend-owned or runtime-owned adapters instead of Discord product modules.

## What Stayed Out of Scope

Even after the cutovers, the branch intentionally avoided mixing in broader refactors so the ownership change stayed easy to validate.

The voice migration should not turn into a redesign of backend text runtime work. It also should not reopen the completed image branch. And it should not force TTS and realtime voice into one abstraction if that makes the design worse. The point of this branch is ownership cleanup and boundary correction, not uniformity for its own sake.

## Validation Snapshot

There is already useful voice-related test coverage, and the closeout work added focused coverage for the backend/runtime realtime seam and the cleaned-up Discord event mapping.

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
- internal realtime websocket invalid-payload rejection and `session.ready` forwarding
- Discord-side mapping of backend realtime audio/text/completion events

That standing coverage was enough to support the branch closeout claim once combined with the branch closeout review and validation pass. It does not prove every possible runtime behavior, but it does prove the migration goal that mattered for this branch: product-facing voice modules no longer call provider APIs directly.

The broader validation expectations remain the usual ones for this repo:

- `pnpm lint-check`
- `pnpm review`
- `pnpm validate-footnote-tags`
- `pnpm validate-openapi-links`

## Deletion Gate Result

The deletion gate is satisfied for voice.

Reflect TTS now uses the backend-owned internal voice route. Realtime voice now uses the backend-owned websocket boundary instead of a Discord-local provider socket. `pnpm review` is green, the realtime runtime replays `session.ready` for listeners that subscribe after session creation, the Discord realtime layer no longer carries the old `audio_collected` compatibility path or stale event typing, and the closeout validation confirmed that the active Discord voice product paths route through Footnote-owned backend boundaries instead of provider SDK or provider websocket calls.

In short, the core cutover is in place, the realtime seam is cleaned up, and the branch has reached the intended end state for legacy OpenAI voice removal.

## Addendum: Debugging Outcomes

We hit a post-migration reliability issue where the bot would sometimes miss or delay realtime responses when users relied on Discord voice activity/noise suppression. The root cause was that Discord stops sending audio immediately at end-of-speech, which can prevent provider-side server VAD from observing enough silence to close a turn.

### Changes Made

- Added a silence-tail append on Discord speaking end so server VAD can reliably close a turn even when Discord cuts audio quickly.
- Added explicit realtime VAD configuration in the Discord runtime config, including `REALTIME_TURN_DETECTION` and optional server/semantic VAD tuning knobs.
- Added a `/call` voice override option so per-session voices can be selected without changing global config.
- Standardized the realtime greeting with a configurable template (`REALTIME_GREETING`) using a single `{bot}` placeholder.
