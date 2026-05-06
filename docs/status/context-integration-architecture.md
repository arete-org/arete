# Context Integration Architecture Status

This document tracks the work to evolve context integrations into a unified, generalized system within the workflow engine.

## Architecture Overview

Context integrations are outside systems the backend calls during a request to add context, evidence, or reference signals to generation. Each integration follows the workflow context-step pattern.

### Target Execution Model

The workflow runs context integrations in parallel before each generation step:

```
planner → context integrations (parallel) → generate → assess → (loop)
```

Key aspects:

- **Parallel execution**: All eligible context integrations run together in a single batch per cycle, not sequentially chained
- **Assess-driven cycling**: The assess step can signal for another cycle, which re-runs context integrations with updated context needs
- **Fail-open semantics**: If a context integration fails, the workflow continues without that context (no-fabrication guardrail preserved)
- **Budget enforcement**: Cycle limits controlled via existing `maxReviewCycles` budget

### Prerequisites

Before integrations can run in parallel with assess-driven cycling:

1. **Integration registry/discovery** - ChatOrchestrator needs a registration mechanism to know which integrations are available and which are eligible for a given request (not hardcoded single executor)

2. **Parallel execution** - Workflow engine must execute all eligible integrations in parallel within a single cycle, then merge all resulting `contextMessages` into the generation prompt

3. **Assess signal for context** - Assess step needs a mechanism to signal that additional context is needed in the next cycle

4. **Chain budget** - Leverage existing `maxReviewCycles` for cycle limits; may need additional context-specific limits

## Integration Status

| Integration | Pattern | Status |
| ------------ | ------- | ------ |
| `weather_forecast` | context-step | Implemented |
| `trustgraph` | evidence ingestion seam | Not migrated to context-step |
| `web_search` | tool-registry path | Not migrated to context-step |
| `image_scan` | Discord bot layer | Not migrated to context-step |
| `file_scan` | not implemented | Not implemented |
| `reverse_image_search` | not implemented | Not implemented |

## Implementation Sequence

### Phase 1: Foundational Infrastructure

**Issue #339** - Context-step execution infrastructure

- Add integration registry in `chatOrchestrator`
- Implement parallel execution in `workflowEngine`
- Add assess signal for context cycling
- Merge context messages from all integrations into generation prompt

### Phase 2: Integration Migrations

**Issue #337** - TrustGraph context-step migration

- Refactor to run pre-generation through workflow context-step
- Keep predicate view mapping as separate post-generation governance pass

**Issue #336** - Web search context-step migration

- Implement as workflow context-step integration
- Provider-neutral architecture (SearXNG, Brave)
- Remove profile mutation and searchFallbackPolicy reroute logic

**Issue #333** - Image scanning context-step migration

- Move from Discord bot layer to workflow context-step

**Issue #334** - File attachment scanning

- Implement as new context integration
- Support PDF, documents in addition to images

**Issue #335** - Reverse image search

- Implement as new context integration

### Phase 3: Cleanup

- Remove `toolRegistryContextStepAdapter` once weather migrates to direct implementation (Issue #340 pattern)
- Consider removing post-generation evidence ingestion paths that are no longer needed

## Related Work

**Issue #338** - Remove `fast` mode, collapse to two reviewed modes (`balanced`, `grounded`). Both modes use `bounded-review` profile, which enables the assess-driven cycling model.

## Notes

- Each integration implements `ContextStepExecutor` interface directly rather than going through adapter patterns
- All integrations populate `sources` field in `ContextStepResult` for structured citation output
- Workflow engine merges context-step sources into `ResponseMetadata.citations` for trace display

## References

- [Workflow Architecture](../architecture/workflow.md)
- [Context Integrations](../architecture/context-integrations/README.md)
- [Weather Forecast Integration](../architecture/context-integrations/weather-forecast.md)
- [Web Search Proposal](../proposals/web-search-context-integration.md)
- [TrustGraph Architecture](../architecture/context-integrations/trustgraph.md)