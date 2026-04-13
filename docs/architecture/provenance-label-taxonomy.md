# Provenance Label Taxonomy

## Purpose

Define one canonical category map for response metadata labels.
This page is grounded in current emitted fields, contract/schema descriptions,
and test coverage.

## Canonical Categories

### 1) Mode = execution policy

- Meaning: execution policy and routing posture chosen by backend mode logic.
- Primary emitted fields: `metadata.workflowMode.*`
- Notes: this is policy/routing state, not answer posture and not grounding classification.

### 2) TRACE = answer posture

- Meaning: visible response posture (tightness, rationale, attribution, caution, extent).
- Primary emitted fields:
    - `metadata.trace_target`
    - `metadata.trace_final`
    - `metadata.trace_final_reason_code` (only when target/final differ)
    - optional TRACE chips: `metadata.evidenceScore`, `metadata.freshnessScore`
- Notes: TRACE expresses how the answer is shaped, not execution-policy authority.

### 3) Planner = workflow-step influence

- Meaning: influence signal from the planner workflow step in this run.
- Primary emitted fields: `metadata.execution[]` planner event:
    - `kind = "planner"`
    - `purpose`
    - `contractType`
    - `applyOutcome`
    - `mattered`
    - `matteredControlIds`
- Notes: planner metadata records step influence only. It does not define policy authority.

### 4) Steerability controls = control influence

- Meaning: backend control records that explain which controls materially affected execution/output.
- Primary emitted fields: `metadata.steerabilityControls.controls[]`
- Notes: this is distinct from planner-step metadata. Planner may influence control outcomes, but categories remain separate.

### 5) Provenance = record/classification of what happened

- Meaning: grounding classification and structural records for what happened.
- Primary emitted fields:
    - classification: `metadata.provenance`, `metadata.provenanceAssessment`
    - structural record surfaces: `metadata.execution`, `metadata.workflow`, `metadata.trustGraph`
- Notes: keep compact provenance classification separate from policy and TRACE posture semantics.

## Guardrails

- Keep field names stable unless semantic honesty requires change.
- Do not add dual old/new labels.
- Do not add generic label wrappers or analytics-specific label layers.
- Prefer wording clarity, emission-boundary cleanup, and fixture/test enforcement.
