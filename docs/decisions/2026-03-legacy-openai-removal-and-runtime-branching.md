# Completing Legacy OpenAI Removal Across Text, Image, and Voice

**Decision:** Complete the migration away from Footnote's legacy OpenAI-specific runtime code by finishing the text-runtime migration behind `backend`, and by introducing separate Footnote-owned internal boundaries for image generation and voice systems.  
**Date:** 2026-03-18

**Relationship to prior decisions:** This decision extends, but does not replace, [VoltAgent Runtime Adoption (Behind the Existing Backend)](./2026-03-voltagent-runtime-adoption.md). The earlier record established the backend-owned boundary and the first migrated runtime slice. This record defines the broader end-state needed to remove the remaining legacy OpenAI system from product flows.

**How to read this document:** This is an architectural decision record. The context section explains the mixed state that motivated the decision, while the latest branch outcomes live in `docs/status/`.

**Implementation context:** The motivating mixed state is summarized below and in [VoltAgent Reflect Runtime Status](../status/archive/2026-03-17-voltagent-reflect-runtime-status.md).

---

## 1. Plain-Language Summary

This decision says three simple things:

- Footnote will finish removing the old OpenAI-specific architecture rather than keeping it around as a permanent second system.
- Text, image, and voice will not all be forced through one shared implementation seam just for consistency.
- `backend` remains the public control plane, while provider/framework-specific code moves behind Footnote-owned modality-specific runtime adapters.

In practice, that means:

- `@footnote/agent-runtime` continues evolving into a Footnote-owned home for modality-specific runtime adapters
- text remains the first and most mature migrated slice inside that package
- image generation gets its own internal boundary
- TTS and realtime voice get their own internal boundaries

This decision is about architecture, ownership, and end-state. It is not the place to track every branch-level task or code hotspot.

---

## 2. Working Definitions

These terms are used repeatedly in this document:

- **Public control-plane boundary:** the main entrypoint other Footnote surfaces call. In this repo, that is `packages/backend`.
- **Runtime adapter:** a Footnote-owned internal interface plus implementation that hides provider/framework-specific behavior.
- **Runtime seam:** the replaceable architectural boundary where runtime adapters plug in.
- **Provider/framework-specific code:** code that knows direct SDK details, transport details, or framework-native request/response types.
- **Product-facing module:** code that primarily owns user-facing behavior, orchestration, or API shape, rather than provider integration.

---

## 3. Context Behind The Decision

Footnote has already made one important architectural move:

- `packages/backend` remains the public control-plane boundary for `web` and `discord-bot`
- `@footnote/agent-runtime` now hosts the first provider-agnostic runtime adapters, starting with text generation
- VoltAgent is active for plain text reflect generation

That move was still incomplete when this decision was made.

The system still had a split personality:

- some text generation already flows through the new runtime seam
- some text planning and tertiary text features still depend on legacy OpenAI-specific code
- image generation still builds provider clients in product-facing code
- TTS and realtime voice still speak directly to provider APIs

The earlier VoltAgent adoption decision intentionally scoped the first step to text reflect generation behind backend. That was the correct MVP because it was the simplest high-value slice. It was not intended to define the permanent scope of runtime abstraction as "text only."

The remaining legacy OpenAI system should now be treated as transitional compatibility code that is scheduled for removal, not as a permanent parallel architecture.

Those migration gaps have since been closed for the text, image, and voice branch scopes documented in:

- [Legacy OpenAI Text Migration Status](../status/archive/2026-03-18-legacy-openai-text-migration-status.md)
- [Legacy OpenAI Image Migration Status](../status/archive/2026-03-19-legacy-openai-image-migration-status.md)
- [Legacy OpenAI Voice Migration Status](../status/archive/2026-03-21-legacy-openai-voice-migration-status.md)

---

## 4. Decision

Footnote will complete legacy OpenAI removal through three coordinated migration branches:

1. **Text systems** finish migration behind the backend-owned text runtime seam.
2. **Image generation** moves behind a dedicated Footnote-owned image runtime boundary.
3. **TTS and realtime voice** move behind dedicated Footnote-owned voice runtime boundaries.

The architectural target is:

- `packages/backend` remains the only public runtime/control-plane boundary for `web` and `discord-bot`
- `@footnote/agent-runtime` evolves from a text-first runtime seam into a Footnote-owned home for modality-specific runtime adapters
- text, image, and voice are allowed to use different modality-specific adapters inside that package family
- provider/framework-specific code is allowed only behind Footnote-owned runtime adapters
- legacy `OpenAIService` and the legacy text runtime adapter are transitional compatibility layers slated for deletion once migration gates are satisfied

This is a removal of a legacy architectural dependency, not merely a package import cleanup.

Legacy OpenAI is considered removed only when all of the following are true:

- no product text flow depends on direct legacy `OpenAIService.generateResponse()` calls
- no product-facing image or voice module constructs provider clients directly
- provider/framework-specific behavior is isolated behind replaceable Footnote-owned runtime adapters
- Footnote-owned provenance, trace, auth, incident, and review semantics remain outside framework-native adapters

Those are still the right architectural gates. The linked text, image, and voice status docs record the resulting branch-level outcomes against them.

---

## 5. What Stays True

This decision keeps the following architectural commitments intact:

- `backend` remains the only public control plane for `web` and `discord-bot`
- Footnote continues to own public API contracts and user-facing response semantics
- Footnote-owned provenance, trace metadata, auth, incident, and review behavior stay outside framework/provider adapters
- fail-open behavior is preserved when optional runtime features are missing or degraded
- response metadata and provenance guarantees must not silently weaken during migration
- VoltAgent-native or provider-native types must not leak into Footnote public contracts
- no new externally visible service boundary is introduced for this migration

---

## 6. Architecture by Branch

### 6.1 Text systems

For text, `@footnote/agent-runtime` remains the canonical runtime seam and the most mature modality-specific runtime adapter path.

What stays the same:

- public surfaces continue to talk to `backend`
- Footnote continues to own planner policy, provenance, trace metadata, and output contracts

What changes:

- planner, generation, and output participate in one backend-owned text pipeline
- backend planning must stop calling legacy OpenAI code directly
- tertiary text flows such as provenance-lens rewrites and `/news` must route through the same backend-owned text path, or through an equivalent shared Footnote-owned text abstraction

What this decision does **not** require:

- it does not require planner logic to become a VoltAgent-native construct
- it does not lock the planner to one exact interface shape

The key architectural requirement is abstraction: planner logic must depend on Footnote-owned runtime adapters rather than provider SDKs or framework-native types. That keeps VoltAgent practical as the main framework while preserving provider agnosticism and leaving room for future VoltAgent feature adoption inside Footnote-owned seams.

### 6.2 Image generation

Image generation moves behind a dedicated Footnote-owned image runtime boundary.

What stays the same:

- image generation remains a Footnote-owned product capability
- image presentation, traceability cues, and user-facing orchestration remain outside provider-specific code

What changes:

- product-facing image code stops constructing provider clients directly
- image-provider selection and model wiring stay internal to the image boundary
- image runtime adapters should live in the same `agent-runtime` package family unless a later decision establishes a better home

What this decision does **not** require:

- it does not require image generation to use VoltAgent
- it does not require image generation to share the text runtime seam

This branch is intentionally separate because image generation has different artifact, streaming, and delivery concerns than text generation.

### 6.3 TTS and realtime voice

TTS and realtime voice move behind Footnote-owned voice runtime boundaries.

What stays the same:

- voice remains a Footnote-owned user-facing capability with Footnote-owned consent, engagement, and control-plane semantics

What changes:

- TTS stops calling provider APIs directly from product-facing modules
- realtime voice/session code stops connecting directly to provider APIs from Discord/runtime modules
- voice runtime adapters should live in the same `agent-runtime` package family unless a later decision establishes a better home

What this decision does **not** require:

- it does not require TTS and realtime voice to share one implementation seam
- it does not require voice systems to use VoltAgent

This branch remains separate because speech synthesis and realtime audio transport have different lifecycle and failure-mode concerns than text generation.

---

## 7. Recommended Migration Order

This section is intentionally high-level. Branch-specific execution details should live in separate status docs.

### 7.1 First: finish text migration

Text should be finished first because it already has the strongest runtime seam and the clearest backend-owned contract. It is the first migrated slice of the modality-based runtime architecture, not a special case that permanently defines package scope.

This branch should end with:

- planner and generation no longer split across legacy and new text paths
- search, citation, and provenance-sensitive behavior preserved under the new path
- tertiary text flows no longer choosing providers locally

### 7.2 Second: isolate image generation

Image generation should move next because it is a clearly bounded modality with strong provider-specific code at the product edge.

This branch should end with:

- a dedicated image boundary
- no direct provider client creation in product-facing image modules

### 7.3 Third: isolate TTS and realtime voice

Voice should follow image because it has the most transport- and lifecycle-specific behavior.

This branch should end with:

- a dedicated TTS boundary
- a dedicated realtime voice/session boundary
- no direct provider transport in product-facing voice modules

### 7.4 Last: remove transitional legacy code

Legacy compatibility code should be deleted only after the earlier branches have reached parity and regression confidence.

---

## 8. Deletion Gates

Legacy OpenAI code may only be deleted when the following gates are true:

- text-path planner and generation parity are covered by tests, including search/citation/provenance behavior
- tertiary text flows no longer call legacy `OpenAIService.generateResponse()` in product paths
- image flows no longer create provider clients directly in product-facing modules
- TTS and realtime voice no longer call provider APIs directly from product-facing modules
- `pnpm review` and the relevant regression suites pass after each branch cutover

Deletion of the legacy text runtime adapter must happen last, after parity is proven rather than assumed.

These remain the deletion gates for any final cleanup PR that removes transitional adapter code from the repository itself.

---

## 9. Consequences and Non-Goals

### 9.1 Consequences

- Footnote will own clearer internal runtime boundaries for text, image, and voice
- `@footnote/agent-runtime` will broaden from a text-first package into a modality-oriented runtime package family
- some existing provider-specific code may temporarily move behind adapters before it is removed entirely
- branch-specific migration can proceed independently while preserving one backend-owned public control plane

### 9.2 Non-goals

This decision does **not** commit Footnote to:

- using VoltAgent for image generation
- using VoltAgent for TTS or realtime voice
- exposing new public network boundaries for media systems
- moving Footnote-owned provenance, trace, incident, or review semantics into provider/framework code

This decision intentionally separates "remove legacy OpenAI architecture" from "standardize every modality on the same framework."

---

## 10. Tracking and Validation

This decision record is architectural. Branch-level inventories, code hotspots, and rollout tracking should live in separate status docs:

- [Legacy OpenAI Text Migration Status](../status/archive/2026-03-18-legacy-openai-text-migration-status.md)
- [Legacy OpenAI Image Migration Status](../status/archive/2026-03-19-legacy-openai-image-migration-status.md)
- [Legacy OpenAI Voice Migration Status](../status/archive/2026-03-21-legacy-openai-voice-migration-status.md)

The decision itself should remain aligned with:

- `cursor.rules` runtime-boundary guidance
- the earlier VoltAgent adoption decision
- the current backend-owned provenance and control-plane architecture

Future implementation branches should treat the following checks as proof-of-migration gates:

- reflect planner/runtime tests
- provenance and citation parity tests
- `/news` and provenance-lens regression tests
- image command/runtime tests
- TTS and realtime voice regression tests
- `pnpm review`

The migration is complete only when those checks show that legacy OpenAI removal did not weaken Footnote-owned user-facing guarantees.
