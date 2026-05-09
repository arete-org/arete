# Feature Proposal: Conversation Context Boundary

**Last Updated:** 2026-05-09

---

## Overview

This proposal introduces `ConversationContextService`, a backend boundary that turns surface-native chat history and related context into structured blocks for prompt assembly.

The goal is to stop context from collapsing into one transcript-style string while preserving Footnote’s existing boundaries around provenance, consent, traces, review, and backend authority.

---

## Why This Is Needed

Current chat inputs still look too much like transcripts by the time they reach the model. Author names, timestamps, bot labels, and message indexes are mixed into the same text the model is asked to answer from. That makes the context useful, but it also teaches the model a format it may copy.

The visible symptom is that the model can answer in the shape of the context wrapper instead of the persona or user-facing reply style. With replies sometimes looking like `[n] At ... said:`, it's clear that the boundary between context data and answer style is too weak.

A dedicated context boundary addresses this without touching orchestration or prompt assembly.

---

## Boundary And Responsibilities

The service has a narrow job: turn surface-specific input into typed context blocks.

`ConversationContextService`:

- Accepts surface-native turns and session metadata.
- Attaches authority and stability metadata.
- Exposes blocks to prompt assembly.
- Fails open when context shaping is partial or unavailable.

It will not assemble final model prompts or own supplemental context such as persona instructions. Persona-related blocks may carry hints or metadata, but persona instruction text stays with the prompt layer.

---

## Context Block Model

Each "context block" should carry:

- `source` such as `conversation`, `persona_context`, `evidence`, `advisory_context`, or `internal_trace`
- `authority` such as `instructional`, `advisory`, `evidentiary`, or `internal`
- `stability` such as `stable`, `semi_stable`, or `volatile` (how likely the block is to change across turns)
- `visibility` such as `model_visible` or `backend_only`
- `content` as structured parts, not transcript wrappers
- optional `redaction` or `consent` metadata

This gives prompt assembly enough information to place blocks deliberately and explain those choices later.

---

## Role-Aligned Rendering Strategy

The canonical context representation should stay backend-owned and structured. Rendering to provider/runtime message formats should happen at the edge.

Recommended pattern:

1. Canonical turns in `ConversationContextService` keep normalized role, metadata, and authority fields.
2. A rendering adapter maps canonical turns to runtime-facing messages (`system`, `user`, `assistant`).
3. Participant identity stays structured (`speakerId`, `speakerLabel`) and follows an explicit projection policy.

This keeps model input aligned with common LLM training formats while preserving Footnote-specific semantics outside provider-native payload shapes.

---

## Temporal Metadata Policy

Timestamp data should remain available as metadata by default and should not be dropped.

Use deterministic temporal rendering rules:

- include one session-level time header (date + timezone)
- avoid per-turn transcript wrappers
- include per-turn time only when a configured time-gap threshold is met

This preserves useful temporal context without teaching the model transcript wrapper styles.

---

## Messages And Envelope Split

Model input should be split into two explicit channels:

1. `messages`: runtime-facing role/content list used for generation.
2. `contextEnvelope`: backend-owned structured metadata for context semantics.

`messages` should remain role-aligned and minimal.
`contextEnvelope` should carry speaker identity, timestamps, provenance-facing metadata, and reduction/cache metadata.

Only explicit rendering rules may project `contextEnvelope` fields into model-visible message text.

---

## Speaker Label Policy

`speakerLabel` handling should be explicit and deterministic:

- Always store `speakerId` and `speakerLabel` in `contextEnvelope`.
- Do not prepend labels in every message by default.
- Project labels into model-visible text only when disambiguation is required (for example, multiple human participants in view).
- Keep assistant identity stable and normalized across turns.

This avoids accidental style bleed while preserving multi-party clarity.

---

## Segmentation And Reduction

Conversation history should be represented as deterministic segments.

Suggested segment model:

- `segmentId` (stable hash from ordered turn ids + reduction config version)
- `turnIds`
- `startedAt` / `endedAt`
- `reductionLevel` (`full`, `compact`, `summary`)
- `summaryRef` (optional pointer to persisted summary content)

Deterministic reduction policy:

- Keep newest `N` turns unreduced.
- Reduce older turns by segment age and token budget pressure.
- Reuse existing summaries when `segmentId` is unchanged.
- Only regenerate summaries when segment content or reduction config changes.

This minimizes churn and creates a clean path for future cache-aware prompt assembly.

---

## Authority And Visibility Rules

The first version should keep five kinds of context separate:

1. Instruction: authoritative and model-visible when policy allows.
2. Advisory context: non-authoritative, but still model-visible.
3. Evidence or retrieved context: model-visible with provenance semantics.
4. Conversation turns: model-visible after surface normalization.
5. Trace/internal review details: backend-only by default.

These classes decide whether a block can be shown to the model, where it can be placed, and how strongly it should influence the answer.

Traces need extra care. They are not memory by default. Any trace-to-model path must be explicit, redacted, and policy-gated.

---

## Prompt Assembly Integration

This should plug into the existing prompt path rather than replace it. The main files to consider are:

- `packages/backend/src/services/prompts/conversationPromptLayers.ts`
- `packages/backend/src/services/chatOrchestrator.ts`

`ConversationContextService` returns blocks. `conversationPromptLayers` still renders prompt text/messages and preserves policy-sensitive instruction order.

Guardrails:

- avoid double-including both raw normalized conversation and rendered context output in the same model payload
- preserve fail-open behavior by falling back to normalized role/content turns if context rendering fails
- keep persona/system layering in prompt layers, not in context service
- enforce one canonical source-of-truth path for generation history per request

---

## Ordering Policy

Ordering should follow three questions:

1. How authoritative is this block?
2. How stable is it across turns?
3. How close should it be to the latest user turn?

In general, stable authoritative material belongs earlier. Volatile advisory material should go as late as possible without hurting answer quality. The latest user turn should remain easy for the model to identify.

This is guidance to validate, not a permanent rule.

---

## Input Contract Sketch

The shape below is illustrative and should be aligned with existing backend contract types before implementation.

```ts
type ConversationSegmentReductionLevel = 'full' | 'compact' | 'summary';

type ConversationContextEnvelope = {
    sessionTimeZone?: string;
    sessionDate?: string;
    temporalPolicy: {
        gapMinutesForTurnTime: number;
    };
    participants: Array<{
        speakerId: string;
        speakerLabel: string;
        roleHint: 'user' | 'assistant' | 'system';
    }>;
    segments: Array<{
        segmentId: string;
        turnIds: string[];
        startedAt?: string;
        endedAt?: string;
        reductionLevel: ConversationSegmentReductionLevel;
        summaryRef?: string;
    }>;
};

type ConversationContextServiceInput = {
    requestId: string;
    surface: 'discord' | 'web' | 'api';
    surfaceContext: SurfaceContext;
    turns: SurfaceConversationTurn[];
    personaHints?: ConversationPersonaHints;
    workflowHints?: ConversationContextWorkflowHints;
};

type ConversationContextServiceOutput = {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    contextEnvelope: ConversationContextEnvelope;
    diagnostics?: {
        stableTokenEstimate: number;
        volatileTokenEstimate: number;
        segmentCount: number;
        summaryReuseCount: number;
    };
};
```

This avoids hard-coding legacy “normalized transcript request” assumptions into the new boundary.

---

## Non-Goals

- No durable memory writes or memory-management UI.
- No consent-model, deletion/export, or retention-policy changes.
- No automatic provider/runtime memory enablement.
- No broad prompt system rewrite.
- No change to backend authority for cost, provenance, review, or incident semantics.

---

## Initial Implementation Scope

1. Add block schema and service interface.
2. Add an adapter from the current surface request shapes.
3. Feed service output into `conversationPromptLayers` without changing which context is included.
4. Keep trace/internal block sources disabled or empty for this scope.
5. Add observability for block churn and stable/volatile token mix.

---

## Acceptance Criteria

- Model-facing prompt material does not include transcript wrappers like `[n] At ... said:`.
- Author/timestamp metadata remains available without transcript-style prose wrappers.
- Runtime-facing conversation messages stay role-aligned (`system|user|assistant`) and serializable.
- Conversation assembly uses explicit `messages` + `contextEnvelope` channels with deterministic projection rules.
- Speaker labels are projected only by policy, not by default per-turn prefixing.
- Prompt assembly still occurs through existing prompt-layer path.
- No new implicit runtime/provider memory feature is enabled.
- `chatOrchestrator` remains backend authority for orchestration and policy seams.
- Fail-open behavior is preserved when context shaping is partial or unavailable.
- Cache diagnostics are reported without changing response semantics.

---

## Metrics To Start

Track a small set of signals first:

- prompt assembly fallback rate
- context-to-message projection rate
- summary reuse rate
- token delta before/after reduction

These are enough to validate the boundary without overcommitting to low-level cache internals.

---

## Risks And Mitigations

A few risks are worth naming early.

- The service could accidentally become the new home for persona or policy text. Persona instruction rendering should stay in the prompt layers.
- Internal trace or review details could become model-visible by accident. `internal_trace` should default to `backend_only`.
- Old and new request shapes could drift during migration. An explicit adapter layer should keep the initial behavior narrow.

---

## Recommendation

Adopt `ConversationContextService` as a narrow, backend-owned context boundary.

It should return structured blocks with explicit authority and visibility metadata, integrate with existing prompt assembly, keep trace-to-model context deferred, and preserve the current memory and consent boundaries.
