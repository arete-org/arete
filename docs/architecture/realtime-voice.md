# Realtime Voice System

## Summary

The realtime voice system is the part of Footnote that lets the Discord bot have a live spoken conversation in a voice channel.

At a high level, the Discord bot handles the Discord-specific work: joining the channel, listening for speech, and playing audio back into the room. The backend handles the AI-specific work: building instructions, opening the provider session, translating provider events, and recording usage.

That split is the main point of the design. The bot does not talk to the OpenAI realtime API directly. It opens a trusted websocket to Footnote's backend at `/api/internal/voice/realtime`, and the backend owns the provider connection from there.

## High-Level Flow

```mermaid
sequenceDiagram
    participant User as User in Discord
    participant VoiceState as VoiceStateHandler
    participant Session as RealtimeSession
    participant Capture as AudioCaptureHandler
    participant Manager as VoiceSessionManager
    participant Backend as /api/internal/voice/realtime
    participant Prompt as Realtime prompt composer
    participant Runtime as OpenAI realtime runtime
    participant OpenAI as OpenAI realtime websocket
    participant Events as RealtimeEventHandler
    participant Playback as AudioPlaybackHandler

    User->>VoiceState: Starts /call and joins voice
    VoiceState->>Session: Start realtime session
    Session->>Backend: session.start
    Backend->>Prompt: Build instructions
    Prompt-->>Backend: Instructions
    Backend->>Runtime: Open provider session
    Runtime->>OpenAI: session.update

    loop User turn
        User->>Capture: Speaks
        Capture->>Manager: PCM chunks
        Manager->>Session: input_audio.append
        Session->>Backend: Forward audio
        Backend->>Runtime: Forward audio
        Runtime->>OpenAI: Append input audio
        Capture-->>Manager: speakerSilence
        Manager-->>Session: Optional silence tail for server VAD
    end

    OpenAI-->>Runtime: Audio + text + completion events
    Runtime-->>Backend: Normalized realtime events
    Backend-->>Session: Forwarded realtime events
    Session-->>Events: Output events
    Events-->>Playback: Audio deltas
    Playback-->>User: Spoken reply
    Events-->>VoiceState: response.done / errors
```

## Settings

These are the main settings that change realtime voice behavior.

| Setting | Default | Allowed Values | Purpose |
| --- | --- | --- | --- |
| `REALTIME_DEFAULT_MODEL` | `gpt-realtime-mini` | Enum (valid realtime model IDs from the shared provider catalog) | Default provider model for realtime voice sessions. |
| `REALTIME_DEFAULT_VOICE` | `echo` | Enum (`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`) | Default output voice when a call does not override it. |
| `REALTIME_GREETING` | `Hey, {bot} here.` | String (non-empty, supports `{bot}`) | Greeting text sent when the session starts. |
| `REALTIME_TURN_DETECTION` | `server_vad` | Enum (`server_vad`, `semantic_vad`) | Selects provider-side turn handling strategy. |
| `REALTIME_VAD_THRESHOLD` | provider default | Number (`0`-`1`) | Optional server VAD sensitivity threshold. |
| `REALTIME_VAD_SILENCE_MS` | provider default | Integer (`>= 0`) | Optional provider silence window used to close a turn. Also used by Discord-side silence-tail injection when `server_vad` is active. |
| `REALTIME_VAD_PREFIX_MS` | provider default | Integer (`>= 0`) | Optional provider prefix padding so the provider keeps some audio before speech start. |
| `REALTIME_VAD_CREATE_RESPONSE` | provider default | Boolean (`true` or `false`) | When true, provider auto-creates a response after a detected turn. |
| `REALTIME_VAD_INTERRUPT_RESPONSE` | provider default | Boolean (`true` or `false`) | When true, new user speech can interrupt an in-flight response. |
| `REALTIME_VAD_EAGERNESS` | provider default | Enum (`low`, `medium`, `high`, `auto`) | Optional semantic VAD eagerness for `semantic_vad`. |
| `/call voice` | per-call override | Enum (same values as `REALTIME_DEFAULT_VOICE`) | Overrides the default voice for one call session. |

## System Breakdown

## 1. Discord Entry and Session Start

The Discord entrypoint is the `/call` slash command in [call.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/commands/call.ts). That command joins the target voice channel, records the initiating user, and optionally records a per-call voice override.

The actual realtime session does not start just because the bot joined the channel. The bot waits for the initiating user to join and start the conversation. That orchestration lives in [VoiceStateHandler.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/events/VoiceStateHandler.ts).

When conversation start is triggered, `VoiceStateHandler`:

- builds participant context
- creates the Discord-side realtime session wrapper
- attaches audio playback listeners
- initializes Discord audio capture
- sends the configured greeting

This keeps the session lifecycle tied to real human participation instead of opening a provider session while the bot is sitting alone in a voice channel.

## 2. Discord-Side Realtime Session

The Discord-side session wrapper lives in [realtimeService.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/utils/realtimeService.ts). Its job is to hide the backend websocket protocol from the rest of the Discord bot.

This layer:

- connects to the trusted backend websocket
- sends `session.start` with voice options and participant context
- streams PCM audio as `input_audio.append`
- sends greeting and other text turns
- normalizes backend events into local audio/text/completion events

This is intentionally not the provider boundary. It is only the Discord-to-backend transport layer.

## 3. Audio Capture and Turn Closing

Discord audio capture lives in [AudioCaptureHandler.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/voice/AudioCaptureHandler.ts). It subscribes to Discord voice receiver streams, decodes Opus to PCM, resamples the audio, and emits `audioChunk` events to the session manager.

Discord voice activity mode can stop sending audio immediately when the user stops speaking. That means the provider may not observe enough trailing silence to close a turn on its own.

To compensate, [VoiceSessionManager.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/voice/VoiceSessionManager.ts) listens for `speakerSilence` events and appends a short silence tail when `server_vad` is active. The silence length is derived from `REALTIME_VAD_SILENCE_MS`, clamped to a safe range. That design lets provider-side VAD stay authoritative while adapting to Discord's voice-activity behavior.

The invariant is simple: Discord streams audio continuously while the user is speaking, but the provider still decides when the turn is complete.

## 4. Backend Trusted Boundary

The backend websocket handler lives in [internalVoiceRealtime.ts](/Users/Jordan/Desktop/footnote/packages/backend/src/handlers/internalVoiceRealtime.ts). This is the public control-plane boundary for realtime voice inside Footnote.

Its responsibilities are:

- authenticate the trusted websocket upgrade
- validate client events against `@footnote/contracts/voice`
- create and own one backend realtime session
- forward normalized events back to Discord
- record backend-owned usage and cost data on `response.done`

This is the main architectural seam. If the Discord bot needs realtime voice, it goes through this handler instead of opening a provider websocket directly.

## 5. Prompt Composition

Realtime prompt composition lives in [realtimePromptComposer.ts](/Users/Jordan/Desktop/footnote/packages/backend/src/services/prompts/realtimePromptComposer.ts). The backend builds one instruction string for the provider session using:

- the shared conversational system layer
- the realtime voice surface layer
- one active persona layer (profile overlay when present, otherwise shared Footnote persona plus the realtime persona supplement)
- the current participant roster
- optional recent transcript summary

That means realtime voice now follows the same prompt model as the rest of the project: shared behavioral rules first, surface-specific delivery rules second, and exactly one active persona layer on top.

## 6. Provider Runtime Adapter

The provider adapter lives in [openAiRealtimeVoiceRuntime.ts](/Users/Jordan/Desktop/footnote/packages/agent-runtime/src/openAiRealtimeVoiceRuntime.ts). This adapter is responsible for:

- opening the OpenAI realtime websocket
- sending the initial `session.update`
- applying the configured voice and turn-detection settings
- waiting for the provider session to become ready
- translating provider events into Footnote-owned normalized events

This is the only place that should know the provider websocket details for realtime voice. Discord and the backend boundary work in Footnote-owned contracts, not provider-native payloads.

## 7. Event Return Path and Playback

Provider events are normalized by the runtime, forwarded through the backend websocket handler, and consumed by Discord's realtime event layer in [RealtimeEventHandler.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/realtime/RealtimeEventHandler.ts).

That event layer emits streamed audio chunks immediately so playback can begin before the full response completes. Playback is then handled by [AudioPlaybackHandler.ts](/Users/Jordan/Desktop/footnote/packages/discord-bot/src/voice/AudioPlaybackHandler.ts), which keeps a guild-local playback pipeline alive long enough to avoid clipping between chunks or turns.

The result is a streamed path in both directions:

- user audio goes Discord -> backend -> provider
- model audio goes provider -> backend -> Discord playback

## 8. Observability and Logging

Realtime voice uses structured logging across Discord, backend, and runtime layers. The logging favors:

- session lifecycle logs
- speaking start/end signals
- response completion logs
- warnings and errors

It avoids noisy per-chunk logs and keeps the default debug output focused on lifecycle and failure signals.

The backend remains the authoritative owner of realtime usage and cost recording. Discord may display or log completion metadata, but provider cost accounting is backend-owned.

## 9. Design Constraints

The current system is built around a few explicit constraints:

- Discord owns Discord UX, not provider session semantics.
- Backend owns the trusted voice control-plane boundary.
- Provider-specific websocket logic stays inside the runtime adapter.
- Server VAD remains authoritative for turn completion in the normal path.
- Discord voice-activity behavior is accommodated with silence-tail injection instead of moving turn closure back into Discord logic.

That gives realtime voice the same ownership story as the rest of the migration work: product-facing code uses Footnote-owned boundaries, and provider-specific behavior sits behind those boundaries.
