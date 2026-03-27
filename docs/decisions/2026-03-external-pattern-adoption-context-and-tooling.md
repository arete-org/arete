# External Pattern Adoption: Context Packaging + Tool Governance

**Decision:** Adopt selected external architectural patterns for context packaging and tool governance, while keeping Footnote's backend boundary, contracts, and provenance/review semantics fully Footnote-owned.  
**Date:** 2026-03-27

---

## 1. Context

Footnote is pre-1.0 and moving fast.

We want better tool behavior and better provenance for retrieval answers.

We do **not** want a large platform migration right now.

Recent work already established core groundwork:

- VoltAgent behind Footnote's backend boundary
- provider tool registry groundwork
- execution event normalization direction

Some external projects show useful patterns for:

- versioned context packaging
- explicit tool governance and capability signaling
- clearer operational visibility around tool execution outcomes

We want to borrow these ideas without changing Footnote's core runtime boundary.

---

## 2. Where The Inspiration Comes From

This decision is inspired by:

- TrustGraph repository and docs:
    - <https://github.com/trustgraph-ai/trustgraph>
    - <https://docs.trustgraph.ai/>
- Internal Footnote direction already recorded in:
    - `docs/decisions/2026-03-voltagent-runtime-adoption.md`
    - `docs/architecture/risk-evaluation-and-breakers.md`

These are **reference inputs**, not adoption mandates.

---

## 3. Decision

Adopt a narrow set of patterns, not a full platform:

1. Context packaging as a first-class, serializable artifact
2. Explicit tool outcome taxonomy (`executed`, `skipped`, `failed`) with stable reason codes
3. Provider/tool capability signaling that degrades fail-open when unsupported

Do not adopt a separate runtime platform, service boundary, or orchestration stack as part of this decision.

---

## 4. Invariants

- `packages/backend` remains the sole public runtime boundary for `web` and `discord-bot`.
- Footnote remains the owner of provenance, trace, auth, incident/review, and public contract semantics.
- Public interfaces stay serializable and framework-agnostic.
- Backend remains the authority for LLM cost recording.
- Operational uncertainty remains fail-open unless an explicit policy requires refusal.

---

## 5. Non-Goals

- Full platform migration to an external framework
- Introducing a new required service/container boundary for this work
- Broad ontology/GraphRAG rollout
- Compatibility layers, migrations, or backfills unless explicitly requested

---

## 6. Adoption Scope

### 6.1 Immediate scope

- Define a Footnote-shaped context package envelope
- Harden provider/tool unsupported behavior semantics
- Ensure reason-code visibility is stable end-to-end

### 6.2 Deferred scope

- Domain-specific ontology expansion
- multi-step graph-heavy retrieval orchestration
- broader external framework alignment work

---

## 7. Acceptance Gates

This decision is considered validated when:

1. Context package envelope is defined and reviewable in contracts/docs.
2. Tool outcomes are consistent and inspectable in metadata/logging.
3. Unsupported provider/tool paths are explicitly fail-open and test-covered.
4. A go/no-go checkpoint is recorded for broader expansion.

---

## 8. Consequences

### Positive results we expect

- Better transparency and reviewability for tool-assisted generation
- Lower ambiguity in runtime/operator diagnostics
- Faster extension path for future integrations

### Tradeoffs to accept

- Additional short-term design/documentation overhead
- Some refactoring pressure on orchestration and metadata surfaces

---

## 9. Follow-up Direction

If acceptance gates pass, next phases may expand:

- richer context packaging lifecycle states
- targeted domain ontologies where citation quality is currently weak
- broader tool integration catalog under the same governance model

If gates fail, retain current architecture and narrow scope to the specific failing surfaces.
