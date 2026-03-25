# Conversation Prompt Alignment Status

## Last Updated

2026-03-25

## Purpose

This note records what the finished conversation-prompt alignment PR actually delivered.
It does not try to describe every related cleanup that may happen later.

The main outcome is that Footnote now has a shared conversational prompt base across Discord chat, Discord realtime voice, and web chat, while the backend text path is now centered on the shared `chat` endpoint and contracts. Follow-up cleanup still exists, but it is separate work.

## Status Summary

This PR is finished.

The prompt-alignment goal landed. Shared conversational system rules now live in the canonical prompt catalog as `conversation.shared.system`, and shared Footnote persona rules now live there as `conversation.shared.persona.footnote`. Backend-owned prompt composition now renders those shared layers first, then adds surface-specific layers for `discord-chat`, `discord-realtime`, and `web-chat`. The one-active-persona model also stayed intact, so profile overlays can still replace the default persona bundle instead of stacking conflicting identities.

The related backend chat unification that shipped with this PR also landed. The active public text route is `POST /api/chat`, the shared web contracts are `PostChatRequest` and `PostChatResponse`, Discord uses `chatViaApi`, web uses `chatQuestion`, and the prompt catalog now includes `chat.planner.system`, `chat.web.system`, and `chat.web.persona.footnote`.

## What Landed In This PR

### 1. Canonical prompt ownership moved into `@footnote/prompts`

The shared prompt package now owns the canonical prompt registry, prompt keys, YAML defaults, and rendering behavior. That gives backend and Discord one source of truth for conversational prompt content instead of separate prompt definitions that can drift.

The catalog now includes the shared conversational keys `conversation.shared.system` and `conversation.shared.persona.footnote`. It also includes the shared text-chat and surface keys used by the active runtime, including `chat.planner.system`, `chat.web.system`, `chat.web.persona.footnote`, `discord.chat.system`, `discord.chat.persona.footnote`, `discord.realtime.system`, and `discord.realtime.persona.footnote`.

### 2. Backend prompt composition is now unified for conversational surfaces

`packages/backend/src/services/prompts/conversationPromptLayers.ts` now assembles prompt layers for the backend-owned conversational surfaces in one place. The ordering is explicit: shared conversational system layer, surface-specific system layer, shared Footnote persona layer, then surface-specific persona layer. That means Discord chat, realtime voice, and web chat now start from the same behavioral base before surface-specific delivery rules are added.

### 3. The active text path is now the shared `chat` path

This PR is not only prompt work. The shipped code also reflects the active backend text path rename. The handler is the `POST /api/chat` route, the contracts use `PostChatRequest` and `PostChatResponse`, Discord and web both call that shared route, and the planner prompt is named `chat.planner.system`. That is enough to describe the active path as backend-owned shared chat, even though some nearby cleanup is still deferred.

### 4. Local startup now rebuilds prompts before launching services

`pnpm start:all` runs `backend:prepare` before starting backend, web, and bot. That matters because `backend:prepare` rebuilds the prompt package, so local startup no longer depends on stale generated prompt artifacts.

## What This PR Did Not Finish

This PR did not try to finish every surrounding cleanup.

The remaining work is mostly naming and simplification work around the shared text-chat stack, not more core prompt alignment. Some backend runtime configuration still uses older `reflect` naming even though the active route is `chat`. Some surrounding docs and nearby code still reflect the older transition history and can be simplified later. Planner and orchestration cleanup can also still go further, even though the active planner prompt and route are already unified enough for the shipped path.

## Bottom Line

The conversation-prompt alignment work for this PR is complete.

Footnote now has one shared conversational base prompt and one shared Footnote persona base across Discord chat, realtime voice, and web chat. The active backend text path is also now centered on the shared `chat` route and contracts.
