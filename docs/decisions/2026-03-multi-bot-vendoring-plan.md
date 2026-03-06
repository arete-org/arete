# Multi-Bot Vendoring Plan: Shared Backend + Persona Overrides

**Decision:** Move to a Footnote-default persona model with per-bot vendor overlays so multiple Discord bot machines can share one backend without prompt/identity conflicts.  
**Date:** 2026-03-06

---

## 1. Context

Footnote currently supports one primary Discord bot runtime pattern. The backend reflect path is shared and stable, but persona behavior is still tightly coupled to hardcoded identity text (notably "Ari") and mixed prompt ownership across bot/backend surfaces.

We want to support easier spin-up of multiple Discord bot machines (vendor profiles) that use the same backend.

This requires:

- a clear default persona baseline,
- instance-scoped override points,
- prompt composition that avoids contradictory identity instructions.

---

## 2. Goals

- Keep a single shared backend for multiple Discord bot runtimes.
- Make Footnote the default base persona.
- Let vendors define profile-specific persona behavior (for example, Ari) using environment-level overrides.
- Prevent prompt conflicts between base persona and vendor persona instructions.
- Preserve provenance, traceability, and existing fail-open behavior.

---

## 3. Decision

### 3.1 Base + overlay model

Adopt a two-layer persona model:

- **Base layer (default):** Footnote-aligned neutral persona and behavior constraints.
- **Overlay layer (vendor):** optional profile-specific instructions injected per bot machine.

### 3.2 Multi-machine architecture boundary

Treat each Discord bot machine as an independent surface adapter that can supply profile context while sharing the same backend orchestration and trace pipeline.

### 3.3 Backward compatibility

If no vendor overlay is configured, the system must behave as Footnote default without breaking existing flows.

---

## 4. High-Level Plan

### Phase 0 - Baseline hardening

- Normalize baseline persona text to Footnote-first language in shared prompts.
- Remove or neutralize hardcoded identity references that would conflict with overlays.
- Keep tone/safety/provenance constraints unchanged.

### Phase 1 - Bot-level profile configuration

- Add bot runtime env variables for profile identity and overlay content.
- Support either inline text override or path-based override (operator-friendly).
- Validate and log active profile config at startup (without leaking sensitive content).

### Phase 2 - Prompt injection path

- Inject vendor overlay instructions into Discord reflect request construction so overrides are instance-scoped.
- Apply the same profile overlay rules to bot-local generation paths (image/realtime/provenance interactions) for consistency.
- Keep fail-open behavior: invalid/missing overlay falls back to base prompt.

### Phase 3 - Mention and engagement consistency

- Centralize mention alias logic so plaintext mention handling is consistent across catchup and engagement paths.
- Ensure default alias set aligns with Footnote default; vendor aliases (for example, Ari) come from profile env config.

### Phase 4 - Update documentation

- Update this document with final results
- Update root README.md to explain vendoring processes for new users
- Update DeepWiki instruction to explain this system and user processes
- Ensure repo-wide standardization to the default Footnote persona and removal of Ari

---

## 5. Invariants

The implementation must preserve the following invariants:

- **Invariant A:** A bot machine only applies its own configured profile overlay.
- **Invariant B:** Missing/invalid overlay configuration never blocks execution; base persona remains active.
- **Invariant C:** Provenance metadata and trace persistence continue to function unchanged.
