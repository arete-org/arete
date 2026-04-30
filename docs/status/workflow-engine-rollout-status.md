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

- **Planner timing**: Completed. Planner now runs inside workflow timing
  through injected `PlannerStepExecutor` and `PlanContinuationBuilder`.
  Workflow owns plan-step ordering and plan lineage.

- **Post-plan message assembly seam**: Completed. Planner-applied
  message/payload assembly is now routed through the
  `PlanContinuationBuilder` seam and feeds workflow continuation
  (`terminal_action` or `continue_message`). Assembly wiring is still created
  in orchestrator-owned dependency setup.

- **Planner lineage cleanup**: Completed for normal runtime. Workflow-owned
  `plan` step is now the canonical planner lineage source; duplicate planner
  metadata bridging was removed from normal execution paths.

## Pending Work

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
