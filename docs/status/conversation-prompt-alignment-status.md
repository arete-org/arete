# Conversation Prompt Alignment Status

## Last Updated

2026-03-21

## Purpose

This note tracks the prompt-alignment work underway across Discord chat, realtime voice, and Reflect. The goal of this branch is not to redesign every chat surface at once. The goal is to make the conversational behavior feel like one Footnote system instead of several separate prompt stacks that happen to share some wording.

This document is written as an in-progress branch summary for someone joining the work later. It focuses on what has already landed, what direction the branch is moving in, and what still remains open.

## Current Status

Status: In progress, with the shared conversational prompt foundation now in place but the broader chat unification work still unfinished.

Footnote now has a shared conversational prompt core that is used by Discord chat, realtime voice, and Reflect. That shared layer carries the cross-surface behavior we want to be consistent everywhere, such as truthfulness, uncertainty handling, no fake retrieval claims, and the general Footnote tone. Surface-specific prompts still exist, but they now sit on top of that shared base instead of duplicating the same ideas in three different places.

In plain language, this means the bot should now sound more like the same assistant no matter where it is answering. Discord text, realtime voice, and Reflect can still format replies differently for their own surfaces, but they now start from the same behavioral rules.

## What Changed

The main structural change so far was the introduction of shared conversational prompt layers. The prompt catalog now includes a shared conversational system prompt and a shared Footnote persona prompt. Those layers are composed first, and then each surface adds its own delivery rules on top. Discord chat still has Discord-specific text behavior. Realtime voice still has voice-specific pacing and brevity rules. Reflect still has web-oriented citation and explanation behavior. The important change is that those differences now sit on top of a shared base instead of replacing it.

The backend also now has a small prompt-layer helper that builds the system and persona bundles for a conversational surface in one place. That removed some duplication from the backend prompt assembly path and made the layering model easier to follow. On the Discord side, prompt composition was cleaned up in a similar way so the bot no longer has one composition path for chat and another unrelated path for realtime. This is useful groundwork for the larger chat unification work, but it is still groundwork rather than the end state.

The active persona model was kept, but clarified. The system still uses exactly one active persona layer at runtime. If a profile overlay is configured, that overlay replaces the default persona bundle for the surface. If no overlay is configured, the default bundle is the shared Footnote persona plus the surface-specific persona supplement.

## Why This Matters

Before this work, the surfaces were close in spirit but not fully aligned. Realtime voice was more focused on short spoken style. Discord chat and Reflect were stronger on reasoning discipline, attribution boundaries, and truthfulness rules. That made the product feel more fragmented than it needed to be. Small prompt changes also had to be copied into multiple places, which is the kind of branch drift that becomes expensive later.

The new layering model fixes that by separating two concerns that were previously mixed together. First, there is the shared Footnote behavior that should be consistent everywhere. Second, there is the surface-specific delivery style that should stay different where it needs to. That separation is simpler to reason about and safer to maintain.

This also makes future prompt work cheaper. If the project wants to tighten uncertainty language, adjust anti-bot-loop behavior, or improve how Footnote explains its reasoning boundaries, that work can now happen in one shared layer instead of being repeated across every surface prompt.

## What Did Not Change

This branch has not merged all chat execution paths into one backend `chat` capability yet. Reflect is still the main backend-owned text endpoint, and Discord still acts as a surface adapter that builds a request and sends it to that backend path. Realtime voice is still a separate voice-specific workflow because it has different transport, timing, and output constraints.

This branch also did not force all surfaces to speak in the same style. Realtime voice is still shorter and more spoken. Reflect is still better suited for explicit reasoning and citations. Discord chat is still optimized for Discord interaction patterns. The change here was alignment of behavior, not flattening every surface into one generic prompt.

## Next Direction

The likely next step is to finish the naming and orchestration cleanup so Discord chat and the current Reflect endpoint become one general backend `chat` capability used by both Discord and web. The prompt work in this branch is an important prerequisite for that direction. It gives the project one shared conversational base before trying to unify the surrounding planner, route, and request/response naming.

That next step is larger than a prompt edit. The working plan is to replace the current `reflect`-named chat path with one general `chat` path, including a backend route rename from `/api/reflect` to `/api/chat`, shared request and response naming around `PostChatRequest` and `PostChatResponse`, and one backend planner contract used by both Discord and web. In that model, Discord and web would still stay as separate surfaces, but they would become thin adapters over the same backend chat core instead of feeling like two partly overlapping systems.

The planner work is also expected to become more explicit in the next phase. Right now, planner behavior is still framed around the current Reflect path. The planned direction is one shared backend planner prompt and one shared structured planner output schema for both Discord chat and web chat. Surface-specific behavior would still exist, but it would be handled as policy inside the shared orchestrator rather than by keeping separate planner identities.

The expected shape after that work is simpler to describe. There would be one backend-owned chat capability, one planner/orchestrator path behind it, one shared conversational prompt base, and then surface policy on top for Discord and web. Discord would still be allowed to react, generate images, or use TTS when the returned action calls for it. Web would still be restricted to message-style responses. Realtime voice would remain separate because it has different transport and timing constraints, but it would continue to share the same conversational prompt discipline.

So this branch is best understood as the first half of a broader cleanup. The prompt alignment work has already landed. The planned route, contract, planner, and orchestrator unification work has not landed yet, but this branch is now structured around that direction instead of treating prompt cleanup as a self-contained end state.
