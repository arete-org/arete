# Workflow Engine Rollout Status

## Purpose

This tracks the small amount of workflow-engine work that still remains open.

The main current architecture is in:

- `docs/architecture/workflow.md`

If everything here lands, this status note can be removed.

## Completed

### weather_forecast context-step integration

Status: `done`

`weather_forecast` execution timing has been moved into the workflow
context-step path. This is the first concrete context integration that uses
the workflow-engine-owned context-step execution flow.

The execution flow is now:

1. `chatOrchestrator` builds context-step request and executor for weather
2. `chatService` passes these to `runBoundedReviewWorkflow`
3. `workflowEngine` executes the context step before generation
4. Weather success injects context messages into generation prompt
5. Weather clarification stops generation and returns clarification response
6. Weather failure continues fail-open (no-fabrication guardrail preserved)

Ownership summary:

- planner selection: orchestrator-owned (pre-workflow)
- weather execution timing: workflow context-step-owned
- concrete provider logic (Open-Meteo): adapter-owned
- web_search: unchanged (not migrated)
- planner: unchanged (not migrated)

The context-step adapter (`toolRegistryContextStepAdapter.ts`) keeps the
workflow engine provider-neutral while preserving weather tool semantics.

### Mode coverage

The context-step weather execution path currently applies to:

- `bounded-review` profile (balanced/grounded modes): Uses workflow engine with
  context-step weather execution.

The following modes/profiles do NOT use the context-step path:

- `generate-only` profile (fast mode): Bypasses workflow engine entirely and
  does not use the context-step path. Weather execution would need separate
  handling if fast mode weather support is desired.

This split is intentional for now: the fast/generate-only path is a direct
single-pass generation without workflow orchestration, so it doesn't have the
infrastructure to inject context before generation.

## Still Open

### Tool step expansion

Status: `pending`

Additional tool integrations beyond weather_forecast have not yet been moved
into the workflow context-step path. The infrastructure is in place; each
additional tool would follow the same pattern as weather.

The remaining goal is:

- extend context-step path to additional tools as needed
- maintain fail-open semantics for each integration

### Planner as a first-class workflow step

Status: `pending`

Planner still runs before workflow execution in `chatOrchestrator`.

Today the runtime can attach planner lineage into the workflow record so traces
can show that planner mattered. That bridge is useful, but planner timing and
execution are still not workflow-engine-owned.

The remaining goal is:

- move planner timing into workflow execution
- keep planner authority bounded under the same existing policy rules
- preserve the current boundary that planner influence is not workflow
  authority

## Keep This Doc Small

Do not use this file as a second architecture doc.

When workflow behavior becomes current architecture, move that explanation into
`docs/architecture/workflow.md`.

Leave this file only for work that is still genuinely open.
