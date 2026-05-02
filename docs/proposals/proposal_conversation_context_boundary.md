# Feature Proposal: Conversation Context Boundary

**Last Updated:** 2026-05-01

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
type ConversationContextServiceInput = {
    requestId: string;
    surface: 'discord' | 'web' | 'api';
    surfaceContext: SurfaceContext;
    turns: SurfaceConversationTurn[];
    personaHints?: ConversationPersonaHints;
    workflowHints?: ConversationContextWorkflowHints;
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
- Prompt assembly still occurs through existing prompt-layer path.
- No new implicit runtime/provider memory feature is enabled.
- `chatOrchestrator` remains backend authority for orchestration and policy seams.
- Fail-open behavior is preserved when context shaping is partial or unavailable.
- Cache diagnostics are reported without changing response semantics.

---

## Metrics To Start

Track a small set of signals first:

- stable-token vs volatile-token estimates
- context block churn rate across turns
- provider cache metadata when available
- prompt assembly error/fallback counts

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
