# How to Read Provenance-Related Metadata

## Why this page exists

This page is the simple map for reading response metadata without mixing
different concepts together.

A few things in Footnote are related, but they are not the same:

- workflow mode
- TRACE
- planner influence
- steerability controls
- provenance

When those get blurred together, the metadata starts telling a muddy story.
This page exists to stop that.

This map is based on the fields the system currently emits, along with the
contract/schema descriptions and the test coverage around them.

## The categories

### Mode = execution policy

**What it means**

Mode describes the kind of run the backend chose.

This is execution policy and routing posture. It tells you how the system
decided to run the request.

**Main fields**

- `metadata.workflowMode.*`

**What it is not**

Mode is not answer posture.
Mode is not provenance.
Mode is not planner influence.

### TRACE = answer posture

**What it means**

TRACE describes the posture of the answer that was targeted or delivered.

It is about how the answer is shaped: tightness, rationale, attribution,
caution, and extent.

**Main fields**

- `metadata.trace_target`
- `metadata.trace_final`
- `metadata.trace_final_reason_code` when target and final differ
- `metadata.evidenceScore`
- `metadata.freshnessScore`

`metadata.evidenceScore` and `metadata.freshnessScore` are optional
TRACE-related chips.

**What it is not**

TRACE is not execution-policy authority.
TRACE is not the same thing as provenance classification.
TRACE helps describe the answer, not the policy that governed the run.

### Planner = workflow-step influence

**What it means**

Planner metadata records what influence the planner step had during this run.

This is step influence, not policy ownership.

**Main fields**

Planner shows up through the planner event in `metadata.execution[]`,
including fields such as:

- `kind = "planner"`
- `purpose`
- `contractType`
- `applyOutcome`
- `mattered`
- `matteredControlIds`

**What it is not**

Planner metadata is not execution policy.
Planner metadata is not the same thing as steerability control records.
It tells you what the planner step affected, not what the system was globally
allowed to do.

### Steerability controls = control influence

**What it means**

Steerability controls record which backend controls materially affected
execution or output.

This is the system's control-influence lane.

**Main fields**

- `metadata.steerabilityControls.controls[]`

**What it is not**

This is not planner-step metadata.
This is not provenance classification.
Planner may contribute to control outcomes in some cases, but the categories
should still stay separate.

### Provenance = what happened and how it is classified

**What it means**

Provenance covers two closely related things:

- the system's compact grounding/classification view
- the structural record of what happened during the run

**Main fields**

Classification fields:

- `metadata.provenance`
- `metadata.provenanceAssessment`

Structural record fields:

- `metadata.execution`
- `metadata.workflow`
- `metadata.trustGraph`

**What it is not**

Provenance is not workflow mode.
Provenance is not TRACE posture.
Provenance should not become a catch-all bucket for every kind of influence in
the system.

## Practical rule of thumb

When reading metadata, ask these questions in order:

- How did the system choose to run? -> mode
- How was the answer shaped? -> TRACE
- What did the planner step influence? -> planner metadata
- Which controls materially affected the run or output? -> steerability controls
- What happened, and how was it classified? -> provenance

If a field seems to answer more than one of those questions at once, that is a
sign the boundary may be getting blurry.

## Guardrails

- Keep field names stable unless semantic honesty really requires a change.
- Do not introduce dual old/new labels.
- Do not add generic label wrappers.
- Do not add analytics-specific label layers here.
- Prefer clearer wording, cleaner emission boundaries, and stronger tests over extra abstraction.
