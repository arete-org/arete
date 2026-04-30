# Workflow Engine Rollout Status

This file tracks the remaining rollout work. The canonical architecture is in
[docs/architecture/workflow.md](../architecture/workflow.md) and
[docs/architecture/context-integrations/README.md](../architecture/context-integrations/README.md).

## Pending Work

- **Planning and review budgets**: Split the old broad deliberation budget into
  separate planning and review limits, such as `maxPlanCycles` and
  `maxReviewCycles`. Planning and review have different jobs, costs, and
  failure modes, so they should not share one vague budget.

- **Planner step ownership**: Planner still runs before workflow execution in
  `chatOrchestrator`. The desired shape is a hybrid workflow step: workflow
  owns planner timing through an injected planner executor, while mode,
  Execution Contract, profile, and policy layers remain authoritative. Planner
  output stays advisory.

- **Planner lineage cleanup**: Planner lineage currently bridges into workflow
  metadata after planner execution. Before moving planner timing, consolidate
  planner step recording so there is one canonical path and no duplicate plan
  events.

- **Tool/context-step expansion**: Only `weather_forecast` uses the workflow
  context-step path. The infrastructure exists for additional tools, but none
  are implemented yet.

- **web_search**: Not migrated to context-step execution. It still uses the
  current search/runtime path. The proposal in
  [docs/proposals/web-search-context-integration.md](../proposals/web-search-context-integration.md)
  describes the intended provider-neutral direction.

- **maxIterations=0 semantics**: When `maxIterations=0`, the workflow completes
  after initial generation with `terminationReason: 'goal_satisfied'`. This is
  single-pass generation without a review loop. Documentation follow-up is
  optional.

## Related Docs

- [Workflow Architecture](../architecture/workflow.md)
- [Context Integrations](../architecture/context-integrations/README.md)
- [Weather Forecast Integration](../architecture/context-integrations/weather-forecast.md)
- [Web Search Context Integration Proposal](../proposals/web-search-context-integration.md)
