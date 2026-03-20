# Legacy OpenAI Image Migration Status

## Last Updated

2026-03-19

## Purpose

This note explains what this branch ended up doing for image migration, why the scope grew, and what architectural decisions we made along the way.

The long-term direction still lives in:

- [Completing Legacy OpenAI Removal Across Text, Image, and Voice](../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md)

This file is the branch review. It is meant to be easier to read than the decision record, especially for someone joining the work later.

## Current Status

Status: Complete for the image branch target

At a high level, this branch finished the image cutover. Discord no longer owns provider-specific image execution. The active image path now runs through a backend-owned boundary, with `@footnote/agent-runtime` handling the provider-facing runtime logic underneath it. Discord still owns the user-facing parts of the feature, such as command orchestration, embeds, retry and variation controls, cached follow-up context, and final delivery.

That part was expected. What was less obvious at the start is that the migration exposed several related cleanup problems that were worth fixing in the same branch. Once image execution moved behind backend, it became hard to justify leaving prompt assembly, model lists, pricing logic, and helper behavior duplicated across packages. The branch therefore grew from "move image generation off the Discord edge" into a broader cleanup of ownership boundaries.

## What Changed

The most important decision was to let backend fully own image prompting. Early in the branch, it became clear that routing image execution through backend while still letting Discord compose system and developer prompts would leave the boundary half-finished. We removed `systemPrompt` and `developerPrompt` from the trusted image request, and backend now assembles those prompts itself. That includes the active bot-profile overlay behavior, so the same persona rules still apply, but they are now resolved on the backend side where image execution actually lives.

The second big decision was to restore preview streaming instead of accepting a regression. The first backend-owned image path was simpler, but it dropped the partial image previews that made `/image` feel responsive. Rather than introducing a separate streaming endpoint, we kept `POST /api/internal/image` as the single trusted route and added an NDJSON streaming mode. That let us preserve the clean boundary while bringing back preview thumbnails.

The branch also uncovered too much duplication around configuration and model selection. Image model enums were being restated in contracts, schemas, and Discord command code. Bot-profile parsing and overlay formatting were also duplicated between backend and Discord. We cleaned both up. The shared model registry now drives contracts, schema validation, and Discord image choices, and the bot-profile parsing and overlay formatting now come from one shared implementation.

Another useful cleanup fell out of the pricing work. Once backend-owned image and helper execution was in place, Discord-local cost estimation no longer made sense as an authoritative source of truth. We moved pricing tables and pure estimation logic into shared code, kept backend as the owner of accounting, and removed stale Discord-local spend tracking and cost-based engagement heuristics. This left the architecture simpler and easier to explain: backend records spend, Discord displays returned facts when needed.

The last scope expansion came from helper flows. Reflect attachment grounding was still using a Discord-local image description helper, which meant one more user-facing OpenAI call was still happening at the product edge. Instead of creating a new endpoint just for that case, we reused the existing trusted internal text route and added a narrow `image_description` task there. That kept the route model consistent and let backend own both execution and accounting for that helper too.

## Decisions That Matter

The branch made a few decisions that are worth calling out explicitly because they shaped the final code:

Image does not use VoltAgent in this branch. The important requirement was a Footnote-owned boundary, not using the same runtime abstraction as every other modality. For images, the better fit was a backend-owned control-plane route backed by an image-specific runtime in `@footnote/agent-runtime`.

We chose to keep Discord as an orchestration layer, not a provider layer. That means Discord still handles command UX, retries, variations, embeds, and follow-up state, but it no longer builds provider requests, constructs image clients, or assembles backend-owned prompts.

We removed Alternative Lens from `discord-bot` instead of migrating it. That feature is expected to change heavily, so preserving or rehosting it in backend would have added complexity without giving the project a stable long-term win. The branch leaves only a small note that the work was intentionally deferred.

We also decided that this branch should stop at image-specific ownership cleanup, not turn into a full prompt-centralization effort across reflect, realtime, provenance, or voice. That work may still happen later, but it was intentionally kept out of scope here.

## Final Architecture in Plain Language

Today, the image flow is easier to describe than when the branch started. A Discord image request goes to backend through `POST /api/internal/image`. Backend assembles the image prompt, applies the active profile overlay, and calls the image runtime. The runtime owns provider-specific request mapping, streaming preview handling, response normalization, and image cost estimation. Backend returns normalized image results, and Discord turns those into the user-facing command experience.

Reflect image actions, retries, and variations all use that same backend-owned image path. Attachment grounding for reflect now uses the existing trusted internal text route with the `image_description` task, so that helper is also backend-owned instead of being a Discord-local OpenAI call.

This means the image branch now has a clean ownership story: backend owns prompt assembly, execution, accounting, and normalization; the runtime package owns provider-specific image behavior; Discord owns orchestration and presentation.

## Cleanup That Happened Along the Way

Several pieces of cleanup were not the original headline goal, but they were worth doing because they removed real confusion.

We deleted the old Discord-local image adapter and the Discord-local image prompt builder. We replaced repeated image model enums with one shared registry. We replaced repeated profile parsing and overlay logic with a shared implementation. We centralized pricing tables and pure cost math, and removed stale Discord-local spend tracking that no longer matched the backend-owned architecture. We also renamed the internal text client in Discord so it no longer reads like a news-only abstraction when it now handles multiple trusted text tasks.

We also refreshed the dependency-graph docs and cleaned up the root build and Docker build paths so the branch is not only architecturally cleaner, but also easier to validate before opening a PR.

## What Stayed Out of Scope

This branch did not attempt a broader prompt-centralization pass outside image-related work. It also did not redesign Alternative Lens; it removed the old Discord implementation instead. Finally, it did not move every remaining local OpenAI utility into backend. A few intentionally local utilities still exist where they are not part of this image migration boundary.

## Validation Snapshot

The branch was validated after the migration and cleanup work landed. That included focused tests for the shared profile logic, contracts, the image runtime, backend image handlers, backend prompt composition, Discord image API clients, image session helpers, and the remaining prompt-path and privacy checks. It also included package builds, ESLint on touched files, `pnpm review`, `pnpm validate-footnote-tags`, and `pnpm validate-openapi-links`.

Before wrapping the branch, we also ran the wider pre-PR path: `pnpm lint-check`, `pnpm type-check`, the full Node test corpus, `pnpm build`, and `docker compose -f deploy/compose.yml build`. Those all passed after the final build and packaging cleanup.

## Deletion Gate Result

The practical deletion gate for this branch is now satisfied. No active Discord image flow constructs an OpenAI client directly. No active Discord image flow calls the provider image Responses API directly. `/image`, reflect-image, retry, and variation all run through the backend-owned image route. Backend-owned image execution now owns prompt assembly, runtime execution, preview streaming, and normalized output.

In short, this branch started as an image migration and ended as a more complete ownership cleanup. That ended up being the right call. The result is easier to reason about, closer to the broader legacy OpenAI removal strategy, and less likely to confuse the next person who has to change it.
