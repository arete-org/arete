# Workflow Engine Rollout Status

## Purpose

This tracks the small amount of workflow-engine work that still remains open.

The main current architecture is in:

- `docs/architecture/workflow.md`

If everything here lands, this status note can be removed.

## Still Open

### Tool step execution

Status: `pending`

The workflow engine already knows about `tool` as a step kind and already has
limit support such as `maxToolCalls`.

What is still missing is first-class tool-step execution in the main chat
workflow path. The bounded chat workflow still runs `generate`, `assess`, and
`revise`. It does not yet run concrete workflow `tool` steps with recorded
call attempts and execution shape.

The remaining goal is:

- execute tool work through real `tool` workflow steps
- record each concrete call attempt in workflow lineage
- define whether that execution is sequential, parallel, or both

### Planner as a first-class workflow step

Status: `pending`

Planner still runs before workflow execution in `chatOrchestrator`.

Today the runtime can attach planner lineage into the workflow record so the
trace can show that planner mattered. That is useful, but it is not the same
thing as planner being a true workflow-owned executed step.

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
