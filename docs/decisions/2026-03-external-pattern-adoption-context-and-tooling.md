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
    - docs/decisions/2026-03-voltagent-runtime-adoption.md
    - docs/architecture/risk-evaluation-and-breakers.md

These are **reference inputs**, not adoption mandates.

---

## 3. Decision

Adopt a narrow set of patterns, not a full platform:

1. Context packaging as a first-class, serializable artifact
2. Explicit tool outcome taxonomy (xecuted, skipped, ailed) with stable reason codes
3. Provider/tool capability signaling that degrades fail-open when unsupported

Do not adopt a separate runtime platform, service boundary, or orchestration stack as part of this decision.

---

## 4. Invariants

- packages/backend remains the sole public runtime boundary for web and discord-bot.
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

Objective D: Context package envelope (schema + tests)

- Deliver one serializable envelope schema with these fields:
    - id: string (stable identifier)
    - ersion: string (schema version, for example 1)
    - provenance: { source: string; chainHash?: string; citations?: Array<{ title: string; url: string }> }
    - payload: { intent: string; messages: Array<{ role: string; content: string }>; toolHints?: Record<string, unknown> }
    - signatures?: { createdBy: string; createdAt: string }
    - metadata?: { profileId?: string; provider?: string; responseId?: string }
- Deliver one serializer/deserializer implementation task and matching unit tests.
- Acceptance criteria:
    - schema is reviewed in one PR and approved by API Owners + Security + UX reviewer
    - checklist complete: serializable, fail-open-safe defaults, no framework-only fields
    - test coverage for parse success/failure and version mismatch behavior

Objective E: Unsupported provider/tool hardening

- Scope current known paths:
    - Providers: openai, ollama
    - Tool: web_search
- For each provider/tool path, define:
    - explicit fallback behavior when unsupported
    - explicit reason codes for skipped/ailed
    - retry policy (if any) and no-retry cases
- Owners:
    - packages/backend: orchestration policy + reason-code propagation
    - packages/agent-runtime: provider/tool mapping + unsupported behavior handling
- Acceptance criteria:
    - integration tests for supported and unsupported paths
    - no silent tool-intent drops

Objective F: End-to-end reason-code stability

- Define stability as:
    - reason code present at orchestration output
    - reason code persisted in metadata/logging path
    - reason code visible in downstream review surfaces
- Verification steps:
    - integration test matrix across provider/tool outcomes
    - logging assertions for required reason-code fields
    - telemetry check that non-executed tool outcomes include reason code
- Rollback criteria:
    - missing reason-code propagation in critical path
    - mismatch between metadata and log reason codes

### 6.2 Deferred scope

- Domain-specific ontology expansion
- multi-step graph-heavy retrieval orchestration
- broader external framework alignment work

---

## 7. Acceptance Gates

This decision is considered validated when:

1. Gate 1 - Context package envelope approved
    - Reviewers: API Owners, Security reviewer, UX reviewer.
    - Approval criteria:
        - one signed-off PR with schema + checklist completion
        - serializer/deserializer task linked and unit tests passing
        - Objective D acceptance criteria complete
2. Gate 2 - Tool outcomes are consistent and inspectable
    - Consistency metrics:
        - 100% of non-executed tool outcomes include reason code
        - 100% of tested provider/tool paths emit one of: xecuted / skipped / ailed
    - Inspectability artifacts:
        - metadata/logging path includes outcome + reason code
        - sample JSON schema/example payload checked into docs or test fixtures
    - Objective mapping: E + F
3. Gate 3 - Fail-open and tests are complete
    - Minimum test targets:
        - at least 6 unit tests (envelope parse/version + reason-code propagation)
        - at least 4 integration tests (supported openai/web_search, unsupported ollama/web_search, retry/no-retry, timeout fallback)
    - Automated threshold:
        - 100% pass on required test subset in CI for merge
    - Edge scenarios covered:
        - unsupported provider/tool pair
        - timeout/transport failure
        - malformed tool payload
4. Gate 4 - Go/no-go checkpoint
    - Decision makers: backend maintainer + runtime owner + one product/UX reviewer.
    - Required evidence:
        - Gate 1-3 checklists complete
        - test artifacts attached
        - short risk summary + rollback plan
    - Go trigger:
        - all critical tests pass and checklist complete within 14 days of gate start
    - No-go trigger:
        - unresolved critical failure path or incomplete checklist after 14 days
    - Objective mapping: D + E + F

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
