# Workflow Engine Rollout Status

This file tracks the remaining rollout work. The canonical architecture is in
[docs/architecture/workflow.md](../architecture/workflow.md) and
[docs/architecture/context-integrations/README.md](../architecture/context-integrations/README.md).

## Pending Work

- **Planner timing**: Planner still runs before workflow execution in
  `chatOrchestrator`. Planner lineage can bridge into workflow metadata, but
  planner authority is still bounded and not workflow-engine-owned.

- **Tool/context-step expansion**: Only `weather_forecast` uses the workflow
  context-step path. The infrastructure exists for additional tools, but none
  are implemented yet.

- **web_search**: Not migrated to context-step execution. Continues through
  separate tool-registry path.

- **Fast/generate-only mode**: Bypasses workflow engine entirely and does not
  use the context-step path. Weather support would need separate handling if
  desired.

- **maxIterations=0 semantics**: When `maxIterations=0`, the workflow completes
  after initial generation with `terminationReason: 'goal_satisfied'`. This is
  single-pass reviewed generation without review loop. Documentation follow-up
  optional.

## Related Docs

- [Workflow Architecture](../architecture/workflow.md)
- [Context Integrations](../architecture/context-integrations/README.md)
- [Weather Forecast Integration](../architecture/context-integrations/weather-forecast.md)
