# Response Metadata

Footnote returns several metadata records next to each other because one
response can have several different explanations. One field may describe how
the request was routed. Another may describe the answer posture. Another may
record what the planner influenced. Another may record what happened during
execution.

The useful reading order is simple: start with mode, then TRACE, then planner
or steerability if you need to understand influence, and finish with
provenance if you need the classified record of what happened.

## The Quick Map

| Question                                                             | Concept                   | Main fields                                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How did the backend choose to run this request?                      | **Mode**                  | `metadata.workflowMode.*`                                                                                                                                          |
| What posture did the answer aim for, and what posture was delivered? | **TRACE**                 | `metadata.trace_target`, `metadata.trace_final`, `metadata.trace_final_reason_code`, optional chips such as `metadata.evidenceScore` and `metadata.freshnessScore` |
| Did planner output affect the run?                                   | **Planner metadata**      | planner entries in `metadata.execution[]`                                                                                                                          |
| Which internal controls materially affected execution or output?     | **Steerability controls** | `metadata.steerabilityControls.controls[]`                                                                                                                         |
| What happened, and how was it classified?                            | **Provenance**            | `metadata.provenance`, `metadata.provenanceAssessment`, with supporting records in `metadata.execution`, `metadata.workflow`, and `metadata.trustGraph`            |

Mode is the routing choice. It tells you how the backend ran the request:
which path it took, where that choice came from, and whether workflow-owned
escalation happened.

TRACE is the posture of the answer. It tells you how the answer was shaped,
not how the request was routed. `trace_target` is the intended posture.
`trace_final` is the delivered posture. `trace_final_reason_code` explains the
gap when those differ. The current runtime stops there. TRACE lifecycle/history
is still future work.

Planner metadata records planner influence inside the run. In practice that
usually means checking the planner entry in `metadata.execution[]` to see
whether planner output was applied, adjusted by policy, or not applied.

Steerability controls are the bounded backend control records for the same run.
They answer a narrower question than planner metadata: which internal controls
materially affected execution or output.

Provenance is the classified record of what happened. The label and assessment
fields give the reviewer-facing summary. The supporting execution, workflow,
and TrustGraph records provide the structural detail behind it.

If you have a trace payload open, a common pattern is:

- `workflowMode` tells you the request ran `grounded`
- the planner event shows a tool suggestion was adjusted by policy
- `trace_final` shows a more cautious delivered answer
- provenance fields tell you how the run was classified after the fact

## Metadata Types

Some of these fields are structural and some are summary-oriented.

Structural metadata is the durable record of what the runtime did. That mainly
means fields such as:

- `metadata.workflowMode.*`
- `metadata.workflow`
- `metadata.execution`
- `metadata.trustGraph`

Heuristic metadata is the runtime's summarized posture or assessment. That
includes fields such as:

- `metadata.trace_target`
- `metadata.trace_final`
- `metadata.evidenceScore`
- `metadata.freshnessScore`
- parts of `metadata.provenanceAssessment`

Some fields are transitional because the implementation is still moving toward
the longer-term shape. Today that mainly means:

- planner metadata living alongside, rather than inside, first-class workflow
  lineage
- TRACE target/final fields without a full lifecycle/history model
- compatibility mirrors or summary fields kept during contract cleanup

For current workflow behavior, read
[Workflow Runtime](./workflow-runtime.md) and
[Workflow Language](./workflow-language.md).
For rationale and history, use the decision and status docs after that.
