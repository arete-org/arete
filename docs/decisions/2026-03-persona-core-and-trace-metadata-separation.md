# Persona/Core Split + Out-of-Band TRACE Metadata

**Decision:** Split core prompt constraints from persona instructions, and generate TRACE metadata out-of-band (not from assistant footer text).  
**Date:** 2026-03-12

---

## 1. Context

Footnote is designed to be vendorable across multiple persona overlays. The current prompt layering can let default Footnote persona language dominate overlay behavior in places where vendors expect profile-first identity/tone.

Separately, TRACE metadata is currently vulnerable to formatting breakage when the assistant is pushed into strong style modes (for example, roleplay/speech transformations) because metadata can be coupled to model text output conventions.

We want:

- core functionality and provenance protocol behavior to remain stable and testable,
- persona behavior to be replaceable per deployment,
- TRACE metadata generation to be robust against user style instructions.

---

## 2. Decision

### 2.1 Prompt layering model

Adopt a core + persona model:

- Core constraints are persona-agnostic and remain authoritative.
- Default Footnote persona is a replaceable persona layer.
- When an overlay is active, it replaces default persona behavior (while preserving core constraints).
- Prompt resolution for active persona is deterministic:
    - If `BOT_PROFILE_PROMPT_OVERLAY` is non-empty, use it.
    - Else, if `BOT_PROFILE_PROMPT_OVERLAY_PATH` is readable, use that file content.
    - Else, use the default Footnote persona key for that path.
- Persona layers are never stacked. Each generation path uses exactly one active persona layer.

### 2.2 Core-constraint scope

Core constraints should prioritize protocol integrity over normative stance text. The core should focus on provenance/traceability/output-contract behavior and capability boundaries, not hardcoded persona identity.

### 2.3 TRACE metadata generation model

Move TRACE metadata generation to a control-plane path:

- Metadata is generated out-of-band from assistant prose.
- Reflect metadata path is a hard cutover to control-plane derivation (no footer marker contract).
- Fail-open behavior is preserved when metadata fields are unavailable.

---

## 3. Invariants

- Persona overlays must not weaken core provenance/traceability protocol requirements.
- User style instructions must not be able to corrupt metadata schema generation.
- No-overlay deployments must still produce coherent default Footnote persona behavior.
- All bot generation paths must compose one core layer plus exactly one active persona layer.

---

## 4. Consequences

- Prompt composition logic will need to separate core text from persona text.
- Existing footer-marker metadata parsing in reflect paths is removed.
- Tests must validate both persona replacement behavior and metadata robustness under adversarial style prompts.

---

## 5. Implementation Status

As implemented in this refactor:

- Shared prompt catalog now separates core and default Footnote persona layers for:
    - reflect chat
    - Discord chat
    - Discord image
    - Discord realtime
- All bot generation paths now run with one active persona layer:
    - default Footnote persona when no overlay exists
    - overlay persona when configured (default persona suppressed)
- Backend reflect orchestration now explicitly composes:
    - one core system prompt
    - one active persona prompt
    - planner output context
- Reflect metadata generation is now out-of-band and control-plane derived.
- Footer-marker parsing (`<RESPONSE_METADATA>`) is removed from backend reflect handling.
- Legacy backend metadata parser utility is removed.
- Planner metadata-toggle plumbing used by the legacy footer path is removed.
- Prompt resolution rules are documented for operators in `docs/architecture/prompt-resolution.md`, including copy/paste template paths for persona overlays.
