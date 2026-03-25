# Conversation Prompt Alignment Status

## Last Updated

2026-03-25

## Purpose

This note tracks a branch that started as prompt-alignment work and then widened into chat unification work. The original goal was to make Discord chat, realtime voice, and web chat feel like one Footnote assistant instead of three loosely related prompt stacks. That prompt work is now mostly in place. The branch is now moving into the next layer down: renaming and simplifying the shared text-chat path so Discord and web both use one backend `chat` capability.

This is an in-progress status note. It is meant to help someone join the branch midstream and understand both what has already changed and what is still being cleaned up.

## Where The Branch Stands

The prompt side is in much better shape than it was at the start of the branch. Footnote now has a shared conversational system layer and a shared Footnote persona layer that sit underneath Discord chat, realtime voice, and web chat. That means truthfulness rules, uncertainty handling, no-fake-retrieval behavior, and the general Footnote tone now come from one shared base. Surface-specific prompts still exist, but they are thinner and more focused on delivery style.

At the same time, the branch has started the bigger rename from the old reflect-shaped backend text path to a general chat path. The active public route is now `POST /api/chat`. Shared request and response types are now named around `PostChatRequest` and `PostChatResponse`. The backend planner, orchestrator, handler, and service files have been renamed to `chat*` naming in the active path, and the Discord and web clients now call that shared chat route directly.

In plain language, the system is partway through a cleanup from "Reflect plus Discord adapter" toward "one backend chat system with Discord and web as surfaces."

## What Has Landed So Far

The shared conversational prompt base is now real code, not just a plan. Discord chat, realtime voice, and web chat all resolve prompts through the same shared conversational layers first, then add their own surface-specific system rules and persona supplement. The one-active-persona rule also stayed intact. If a profile overlay is configured, that overlay still replaces the default persona bundle rather than stacking on top of it.

The backend now has a single helper for conversational prompt layers instead of separate helpers that drifted apart. That made the prompt assembly path easier to follow and removed duplication. Discord-side prompt composition was cleaned up in the same spirit so the text chat path is closer to the backend model.

The backend text route is also now actively moving under `chat` naming. The public API route is `/api/chat`, and the active contracts now use `Chat*` names instead of `Reflect*` names. Discord’s backend API client uses `chatViaApi`, the web client uses `chatQuestion`, and the backend route, planner, orchestrator, and service files have matching `chat` names in the active implementation.

The planner side is only partly unified so far. The prompt catalog now uses `chat.planner.system` as the active shared planner prompt for the text-chat path. That is a meaningful step because it stops Discord and web from drifting at the planning layer. The surrounding code still needs more cleanup, but the branch is no longer working from two different planner identities.

The prompt cleanup also now reflects the ownership boundary more clearly. Web-specific delivery rules still exist, but they now live under the shared `chat` prompt namespace instead of a separate top-level `web` prompt section. That makes it easier to see that web chat is a surface of the shared chat capability, not a separate conversation system.

## What Is Still In Progress

The biggest remaining gap is consistency cleanup. A lot of the active runtime path has been renamed to `chat`, but some comments, docs, test file names, and config descriptions still use older reflect wording. Those are not all correctness bugs, but they do make the branch harder to read. Part of the current work is trimming that leftover naming drift so the codebase tells one coherent story.

The orchestration model is also not fully simplified yet. Discord and web now hit the same backend chat route, but there is still some older surface-specific framing in nearby code and docs. The direction is clear: one backend chat core, one planner/orchestrator path, and surface policy on top. The branch is not fully at that finish line yet.

The runtime config shape is also intentionally mixed right now. The active route and contracts have moved to `chat`, but some backend runtime config still lives under older `reflect` section names. That is deliberate for now so the branch can move without forcing a larger env/config break at the same time. It is a cleanup target, not an accident.

The local startup path needed one correction during this pass. Because the prompt catalog is part of the branch surface now, `pnpm start:all` has to rebuild prompts before launching services. That has been fixed so local startup uses fresh generated prompt artifacts instead of depending on whatever was built last.

## Why The Prompt Work Came First

The prompt alignment was the right first step because it solved a real product problem and also reduced risk for the larger rename. Before this branch, Discord chat, realtime voice, and web chat were similar in spirit but not truly aligned. Voice was optimized for spoken brevity. Web chat was stronger on explicit reasoning and citations. Discord chat sat somewhere between them. That made the assistant feel more fragmented than it needed to.

By creating one shared conversational base first, the branch now has a stable behavioral core before it finishes the backend chat unification. That makes the route and contract cleanup safer. We are no longer trying to merge two execution paths while they still disagree on basic behavior.

## Current Direction

The working target is one backend-owned chat capability for text conversation. Discord and web should both be thin adapters over that backend chat core. Discord can still support Discord-specific actions like reactions, images, and TTS. Web can still stay message-only. The difference is that those surface rules should sit on top of one planner and one orchestration path instead of growing as two partly overlapping systems.

That means the next useful work is not more prompt restructuring. The next useful work is finishing the naming cleanup, tightening the shared planner/orchestrator path, and updating the remaining docs and API descriptions so they describe the system the code is actually becoming.

Realtime voice is not part of this route merge. It should stay on its own voice-specific transport and session flow. The important connection is prompt discipline, not route identity. Voice now shares the conversational base, but it is still a separate product path for transport and timing reasons.
