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
  through injected `PlannerStepExecutor`.
  `workflowEngine` owns plan-step ordering and plan lineage.

- **Post-plan message assembly seam**: Completed. Planner-applied
  message/payload assembly is now routed through the
  `PlanContinuationBuilder` seam and feeds workflow continuation
  (`terminal_action` or `continue_message`). Assembly wiring is still created
  in `chatOrchestrator` dependency setup.

- **Planner lineage cleanup**: Completed for normal runtime. Workflow-owned
  `plan` step is now the canonical planner lineage source; duplicate planner
  metadata bridging was removed from normal execution paths.

## Pending Work

- **Tool/context-step expansion**: `weather_forecast` and `file_scan` now use
  the workflow context-step path. Additional integrations are still pending.

- **web_search provider expansion**: `web_search` is now on the workflow
  context-step path with deterministic provider fallback.
  Next refinement is expanding provider coverage with a SerpAPI adapter and
  aligned config-spec env coverage.

## Related Docs

- [Workflow Architecture](../architecture/workflow.md)
- [Context Integrations](../architecture/context-integrations/README.md)
- [Weather Forecast Integration](../architecture/context-integrations/weather-forecast.md)
- [File Scanning Integration](../architecture/context-integrations/file-scanning.md)
- [Web Search Context Integration Proposal](../proposals/web-search-context-integration.md)
