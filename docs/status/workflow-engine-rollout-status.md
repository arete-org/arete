# Workflow Engine Rollout Status

This file tracks the remaining rollout work. The canonical architecture is in
[docs/architecture/workflow.md](../architecture/workflow.md) and
[docs/architecture/context-integrations/README.md](../architecture/context-integrations/README.md).

## Completed Groundwork

- **Planning/review budgets**: Completed. Workflow limits now separate planning
  cycles from review cycles through `maxPlanCycles` and `maxReviewCycles`.
  `maxDeliberationCalls` remains as a compatibility field.

- **Planner policy application seam**: Completed. `PlannerResultApplier`
  centralizes post-planner policy application such as surface coercion,
  generation override merge, single-tool policy, profile resolution, and
  context-step request derivation.

- **Planner timing**: Still pending. Planner still runs before workflow
  execution in `chatOrchestrator`. The next blocker is moving post-plan message
  assembly into `chatService`, so workflow-owned planner timing can be
  introduced without moving policy logic into `workflowEngine`.

## Pending Work

- **Planner timing cutover**: Move planner invocation into workflow-owned timing
  through an injected planner executor after post-plan message assembly is moved
  into `chatService`.

- **Post-plan message assembly**: Move generation message/payload assembly to a
  bounded `chatService` seam that can consume `PlannerResultApplier` output.

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

## Related Docs

- [Workflow Architecture](../architecture/workflow.md)
- [Context Integrations](../architecture/context-integrations/README.md)
- [Weather Forecast Integration](../architecture/context-integrations/weather-forecast.md)
- [Web Search Context Integration Proposal](../proposals/web-search-context-integration.md)
