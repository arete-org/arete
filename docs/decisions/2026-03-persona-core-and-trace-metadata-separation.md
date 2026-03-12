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

### 2.2 Core-constraint scope

Core constraints should prioritize protocol integrity over normative stance text. The core should focus on provenance/traceability/output-contract behavior and capability boundaries, not hardcoded persona identity.

### 2.3 TRACE metadata generation model

Move TRACE metadata generation to a control-plane path:

- Metadata is generated out-of-band from assistant prose.
- Reflect paths are the initial migration scope.
- Fail-open behavior is preserved when metadata generation is incomplete or unavailable.

---

## 3. Invariants

- Persona overlays must not weaken core provenance/traceability protocol requirements.
- User style instructions must not be able to corrupt metadata schema generation.
- No-overlay deployments must still produce coherent default Footnote persona behavior.

---

## 4. Consequences (Initial)

- Prompt composition logic will need to separate core text from persona text.
- Existing footer-marker metadata parsing in reflect paths will be reduced or removed.
- Tests must validate both persona replacement behavior and metadata robustness under adversarial style prompts.

---

## 5. Implementation Notes (To Be Expanded)

- Use a single active persona layer per response path (default Footnote or custom overlay).
- Keep external reflect response schema stable while changing metadata production internals.
- Start with reflect flows, then evaluate expansion to other generation paths.

---

## 6. Open Questions

- Final deterministic vs model-assisted split for metadata fields (tradeoff count/chips).
- Whether any additional universal safety floor should remain in core constraints.
- Documentation updates needed once implementation details stabilize.
