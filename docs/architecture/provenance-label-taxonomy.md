# How to Read Provenance-Related Metadata

When you look at response metadata, the first question should be:

What am I actually seeing?

The short answer is that Footnote returns several related record types side by
side. They help explain one response, but they do different jobs. Do not treat
them as one combined "why" field.

Use this reading order:

1. Read **mode** to see how the backend chose to run the request.
2. Read **TRACE** to see the posture of the delivered answer.
3. Read **planner metadata** to see whether planner output materially affected
   the run.
4. Read **steerability controls** to see which bounded internal controls
   mattered.
5. Read **provenance** to see what happened and how Footnote classified it.

## The Quick Map

| Question                                                             | Concept                   | Main fields                                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How did the backend choose to run this request?                      | **Mode**                  | `metadata.workflowMode.*`                                                                                                                                          |
| What posture did the answer aim for, and what posture was delivered? | **TRACE**                 | `metadata.trace_target`, `metadata.trace_final`, `metadata.trace_final_reason_code`, optional chips such as `metadata.evidenceScore` and `metadata.freshnessScore` |
| Did planner output affect the run?                                   | **Planner metadata**      | planner entries in `metadata.execution[]`                                                                                                                          |
| Which internal controls materially affected execution or output?     | **Steerability controls** | `metadata.steerabilityControls.controls[]`                                                                                                                         |
| What happened, and how was it classified?                            | **Provenance**            | `metadata.provenance`, `metadata.provenanceAssessment`, with supporting records in `metadata.execution`, `metadata.workflow`, and `metadata.trustGraph`            |

If one field seems to answer two or three rows at once, the docs or the
metadata wording are probably getting muddy.

## What Each Concept Means

### Mode

Mode is about how the system runs.

This is the routing choice for the request, not a description of answer style.
It tells you which broad execution path the backend selected and why.

Read `metadata.workflowMode.*` when you want to answer:

- Did the backend take the fast path or the reviewed path?
- Was the mode requested directly, inferred from the contract, or resolved by
  fallback?
- Did workflow-owned escalation happen?

Do not use mode fields to explain TRACE posture, planner influence, or
provenance classification.

### TRACE

TRACE is about the posture of the answer.

It describes visible answer behavior such as tightness, rationale, attribution,
caution, and extent. It does not describe routing, tool legality, or evidence
provenance.

`trace_target` is the intended posture. `trace_final` is the delivered posture.
`trace_final_reason_code` explains why the delivered posture differs when it
does.

Important current boundary:

- Current runtime does not implement a full TRACE lifecycle or history model.
- TRACE target/final fields are current runtime metadata.
- TRACE lifecycle/history is future direction, not current first-read behavior.

### Planner Metadata

Planner metadata is about planner influence in a run.

It lives in planner entries inside `metadata.execution[]`. Read it when you
want to know whether planner output was applied, adjusted by policy, or not
applied.

Planner metadata is not workflow authority. It does not prove that planner
owned mode, policy, provenance, or control resolution. It records observable
planner influence within backend-owned limits.

### Steerability Controls

Steerability controls are bounded internal control records.

They answer a narrower question than planner metadata: which backend controls
materially affected execution or output in this run?

These controls are not a user-facing rollout, not a scripting surface, and not
a replacement for workflow metadata. They are bounded records of control
influence.

### Provenance

Provenance is about what happened and how it was classified.

The label and assessment fields tell you the reviewer-facing classification.
The supporting execution, workflow, and TrustGraph records give you the
structural record behind that classification.

Use provenance when you want to answer questions like:

- What evidence or process shaped this result?
- What was ignored, dropped, blocked, or classified a certain way?
- What path would a reviewer inspect next?

Do not collapse provenance into TRACE. TRACE is posture. Provenance is
historical and classificatory.

## Metadata Types

Not all metadata has the same status.

### Structural metadata

Structural metadata describes durable runtime facts and record shapes.

Examples:

- `metadata.workflowMode.*`
- `metadata.workflow`
- `metadata.execution`
- `metadata.trustGraph`

This is the best place to start when you need to reconstruct what the runtime
actually did.

### Heuristic metadata

Heuristic metadata describes evaluated posture or judgment-oriented summaries.

Examples:

- `metadata.trace_target`
- `metadata.trace_final`
- `metadata.evidenceScore`
- `metadata.freshnessScore`
- parts of `metadata.provenanceAssessment`

These fields are useful, but they are not orchestration authority.

### Transitional metadata

Transitional metadata exists because the implementation is still evolving.

Examples:

- planner metadata living alongside, rather than inside, first-class workflow
  lineage
- TRACE target/final fields without a full lifecycle/history model
- compatibility mirrors or summary fields kept during contract cleanup

Treat these as current runtime surfaces, but do not mistake them for the final
shape of every future subsystem.

## Current Vs Future

Keep these boundaries explicit when writing or editing docs:

- Current architecture docs explain what the runtime does now.
- Decision records explain why a durable choice was made.
- Rollout and status docs explain landing order, migration progress, or open
  work.
- Future TRACE lifecycle/history work is not fully implemented current
  behavior.

If you need the current workflow/planner explanation, start with
[Workflow Mode Routing](./workflow-mode-routing.md) and
[Workflow Engine And Provenance](./workflow-engine-and-provenance.md).
If you need rationale, read the decision records after that.

## Guardrails

- Keep mode, TRACE, planner influence, steerability controls, and provenance
  separate.
- Prefer clearer wording and stronger tests over new wrapper fields or
  duplicated labels.
- Do not turn decision records into the main current docs.
