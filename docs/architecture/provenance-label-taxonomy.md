# How to Read Provenance-Related Metadata

This is the quick map for reading Footnote metadata without mixing different things together.

These categories are related, but they are not interchangeable:

- **Mode** = how the backend chose to run the request
  Field: `metadata.workflowMode.*`

- **TRACE** = the posture of the answer
  Fields: `metadata.trace_target`, `metadata.trace_final`, `metadata.trace_final_reason_code`, plus optional chips like `metadata.evidenceScore` and `metadata.freshnessScore`

- **Planner** = what the planner step influenced during the run
  Field surface: planner entries in `metadata.execution[]`

- **Steerability controls** = which controls materially affected execution or output
  Field: `metadata.steerabilityControls.controls[]`

- **Provenance** = what happened and how it was classified
  Provenance label/method fields: `metadata.provenance`, `metadata.provenanceAssessment`
  Supporting record surfaces (separate from provenance label/method): `metadata.execution`, `metadata.workflow`, and `metadata.trustGraph`

A simple way to read them:

- “How did the system choose to run?” → **Mode**
- “How was the answer shaped?” → **TRACE**
- “What did the planner affect?” → **Planner**
- “Which controls actually mattered?” → **Steerability controls**
- “What happened, and how was it classified?” → **Provenance**

If one field seems to answer two or three of those at once, something is probably getting muddy.

## Guardrails

- Keep policy, posture, planner influence, control influence, and provenance separate.
- Prefer clearer wording and stronger tests over new wrapper fields or duplicate labels.
