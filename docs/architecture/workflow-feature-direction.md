# Workflow Feature Direction

## Purpose

This note is the current truth for workflow-facing feature work.

Use it when you need to decide:

- what Footnote does today
- what the recent planner-lineage work changed
- what wording should appear in product surfaces
- which module owns which part of the behavior

Keep this note small and current.
If runtime behavior changes, update this file in the same PR.

## Current Workflow Behavior

Today the user-facing workflow modes are:

- `fast`
- `balanced`
- `grounded`

Those modes select the current runtime path:

- `fast` uses the internal `generate-only` profile
- `balanced` uses the internal `bounded-review` profile
- `grounded` uses the internal `bounded-review` profile

The main reviewed path is still:

- `generate -> assess -> revise`

That means:

- `fast` is a single-pass generation path
- `balanced` is a reviewed path with moderate evidence and review posture
- `grounded` is a reviewed path with stricter evidence and review posture

Do not rename these modes in docs or product copy.
Do not present `generate-only` or `bounded-review` as the primary user-facing
labels.

## Review And Fallback

In the reviewed path, `assess` decides whether the draft should finalize or
revise once more.

Use careful language here:

- A review label means a review step ran.
- A review label does not mean the answer was verified.
- `grounded` means Footnote tried to use source-backed behavior where available.
- `grounded` does not mean the answer is guaranteed true.

If workflow-facing UI needs a short explanation, stay close to what actually
happened:

- `Answered in Fast mode`
- `Answered in Balanced mode`
- `Answered in Grounded mode`
- `Reviewed before final answer`
- `Review skipped`
- `Grounding evidence was not available`
- `Planner fallback`

Avoid turning the answer surface into a debug panel.
Keep the short explanation near the answer.
Keep the detailed explanation in the trace surface.

## Planner Lineage

Recent workflow-lineage work added a shared `plan` step shape and a bounded
planner step record.

That changed two things:

1. Workflow metadata can now include planner lineage as a `plan` step when that
   metadata exists for the run.
2. The initial `generate` step can be linked to that planner root in lineage.

What did not change:

- Planner still runs before workflow execution in the main chat path today.
- Planner is still advisory.
- Planner does not become a second policy authority.
- Planner output still sits alongside other execution metadata and should not be
  treated as the whole workflow model.

So the current wording should be conservative:

- okay: `Planned, then generated`
- okay: `Planner fallback`
- okay: `Plan step recorded in workflow trace`
- not okay: `Planner-driven workflow`
- not okay: `Workflow started with planning` unless the actual metadata for that
  run shows it

## What Is Next

These are the workflow-facing features that fit the current runtime shape and
should use the wording rules in this note:

- inline workflow receipt near the answer
- fallback summary when detailed workflow metadata is missing or partial
- short review labels
- grounded wording that explains posture without overclaiming
- budget visibility based on backend-owned usage and cost data

For this phase, the product should describe the run in plain terms:

- what mode ran
- whether a review step ran
- whether planning information is available
- whether Footnote fell back
- whether cost or usage information is available

The product should not imply more than the runtime proves.

## What Is Later

These items are later work, not current behavior:

- replanning as a normal workflow behavior
- generic tool-step abstraction as the main user-facing workflow model
- planner timing fully owned by the workflow engine
- broad workflow receipts that assume every run has the same step structure

When writing tickets or UI copy, mark these as later.
Do not describe them as already landed.

## Language Rules

Use plain product language for the answer surface.
Use exact internal terms only where the implementation detail matters.

Preferred user-facing wording:

| Runtime concept    | Prefer in product copy                    | Notes                                      |
| ------------------ | ----------------------------------------- | ------------------------------------------ |
| `fast`             | `Fast mode`                               | short and direct                           |
| `balanced`         | `Balanced mode`                           | short and direct                           |
| `grounded`         | `Grounded mode`                           | do not imply guaranteed truth              |
| `generate-only`    | `single-pass answer`                      | keep internal id out of UI                 |
| `bounded-review`   | `reviewed answer`                         | keep internal id out of UI                 |
| `plan` step        | `planned` or `plan step`                  | use `plan step` in trace/detail views      |
| `assess`           | `reviewed`                                | do not expose step id unless needed        |
| `revise`           | `revised`                                 | describe what happened                     |
| provenance / trace | `trace` or `details` depending on surface | trace is a product surface, not debug-only |

Preferred maintainer wording in docs and tickets:

- `workflow receipt`
- `review skipped`
- `planner fallback`
- `current workflow behavior`
- `review and fallback`
- `trace output`
- `runtime boundaries`

Avoid in product copy unless there is no better option:

- `bounded-review`
- `generate-only`
- `workflow.steps[]`
- `Execution Contract`

Avoid in docs and tickets unless the exact term is already established and
needed:

- `agentic workflow`
- `orchestration lifecycle`
- `workflow-native semantics`
- `trust layer`
- `governance framework`

## Runtime Boundaries

Keep these boundaries intact when adding workflow-facing features.

### Execution Contract

The `Execution Contract` sets the allowed run rules, limits, and fail-open
behavior.
It governs execution.

### Workflow

Workflow is the bounded step pattern used for the run.
It does not replace the contract.

### Orchestrator

`chatOrchestrator` coordinates the request under the contract.
Planner timing still lives here in the main chat path today.

### Planner

Planner can suggest action details and capability choices.
Planner cannot change run rules, bypass policy, or become the final authority
for mode, profile, safety, or provenance.

### Adapters

Adapters should carry out runtime work and present data already decided by the
backend.
They should not invent new workflow meanings or cost semantics.

### Trace And Provenance

Trace and provenance are product surfaces.
They are not debug-only.
They record what happened.
They do not become a second policy engine.

### Web UI

The web UI should show a short, useful receipt near the answer and leave the
full detail to the trace page.
It should not expose internal names just because they exist in metadata.

## Common Mistakes

- Showing `bounded-review` in user-facing copy when `reviewed` would say the
  same thing more clearly.
- Saying `grounded` means verified or guaranteed true.
- Saying `reviewed` when no review step ran.
- Treating planner lineage support as if planner timing has already moved fully
  into the workflow engine.
- Treating trace/provenance as debug-only and hiding all workflow explanation
  from product surfaces.
- Letting adapters or UI code invent budget numbers that should come from the
  backend.

## Related Docs

- [Execution Contract Authority Map](./execution-contract-authority-map.md)
- [Workflow Mode Routing](./workflow-mode-routing.md)
- [Workflow Engine And Provenance](./workflow-engine-and-provenance.md)
- [Workflow Profile Contract](./workflow-profile-contract.md)
- [Response Metadata](./response-metadata.md)
- [Workflow Engine Rollout Status](../status/2026-04-workflow-engine-rollout-status.md)
