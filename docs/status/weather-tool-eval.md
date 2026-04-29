# Weather Tool Integration Status

## Scope

Operational status for the backend-owned, read-only weather tool path with fail-open and clarification-aware behavior.

Integrated tool: `weather_forecast` (provider: Open-Meteo).

The tool path supports three outcomes:

- `ok`: weather data was fetched and can be used in generation.
- `error`: the tool failed safely; the system records the reason and may continue without weather context.
- `needs_clarification`: the tool found multiple plausible locations and the orchestrator asks the user to clarify before normal generation continues.

Integration points:

- `packages/backend/src/services/openMeteoForecastTool.ts` - Weather tool implementation
- `packages/backend/src/services/tools/weatherForecastToolAdapter.ts` - Orchestration boundary adapter
- `packages/backend/src/services/tools/toolRegistry.ts` - Tool selection registry
- `packages/backend/src/services/chatOrchestrator.ts` - Main orchestration entry

## Explicit Eval Set (8 prompts)

1. `Forecast for Indianapolis, IN for next 3 days.`
2. `Weather in Toronto, CA for 8 periods.`
3. `Weather for 25.7617,-80.1918 (short horizon).`
4. `Tokyo, JP forecast.`
5. `What is the weather in New York?` (ambiguous place query; returns needs_clarification)
6. `Use weather for 39.7392,-104.9903 and summarize precipitation risk.`
7. `Forecast at invalid location payload` (planner emits invalid shape; normalization should drop tool request)
8. `Force weather adapter failure and continue normal response flow.`

## Comparison Frame

- **Without tool path**: normal model generation only.
- **With successful tool path**: backend injects normalized weather tool result when planner emits a valid `weather_forecast` tool intent.
- **With clarification path**: backend returns a clarification message before normal generation when the selected tool reports `needs_clarification`.
- **With failed tool path**: backend records the tool failure and continues safely where appropriate.

Primary quality checks:

- Specificity of forecast details.
- Internal consistency of temperatures/horizon periods.
- Provenance visibility in tool payload (`provider`, `endpoint`, `requestedAt`).
- Graceful degradation on timeout/error.
- Clarification path stops generation and asks user for input clarity.

## Local Validation Evidence

- Tool adapter normalization + resiliency tests:
    - `packages/backend/test/openMeteoForecastTool.test.ts`
- Planner weather contract normalization tests:
    - `packages/backend/test/chatPlanner.test.ts`
- Chat-service tool metadata preservation test:
    - `packages/backend/test/chatService.test.ts`
- Orchestrator weather integration + clarification + forced-failure fail-open tests:
    - `packages/backend/test/chatOrchestrator.test.ts`

## Quality Summary

- Tool-enabled path provides structured forecast facts and explicit provenance metadata for downstream generation.
- Invalid or missing weather location contracts are disabled safely before runtime execution.
- Forced-failure path is fail-open: generation continues and tool execution is recorded as `failed` with `tool_execution_error`.
- Clarification path is a deliberate stop condition, not a failure: the tool returns `needs_clarification` and the orchestrator asks the user which location they meant before continuing normal generation.

## QA Example Details

| Example                     | Input                                               | Expected Behavior                                                                    |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Explicit lat/lon            | `Forecast for 39.7684,-86.1581 for next 3 periods.` | Tool executes with provided coordinates.                                             |
| Full place query            | `Forecast for Indianapolis, IN for next 3 days.`    | Tool geocodes and executes.                                                          |
| Context-provided query      | `Weather in Toronto, CA` or query with countryCode  | Tool geocodes with context; no clarification needed.                                 |
| Ambiguous place             | `What is the weather in New York?`                  | Tool returns `needs_clarification`; orchestrator asks which New York the user meant. |
| No location match           | `Weather in <nonsense place>`                       | Tool returns `location_not_resolved`; system fails safely.                           |
| Provider malformed response | mocked malformed geocoding payload                  | Tool returns `invalid_response`; not treated as ambiguity.                           |
| Error handling              | `Force weather adapter failure`                     | Fail-open: generation continues and failure is recorded.                             |

## Follow-up

- Staging/manual QA of clarification behavior to verify user-facing clarity.
- Tune ambiguity heuristics if they over-trigger or under-trigger.
- UI affordances for structured clarification options (future surface work).
- Explore broader use of ToolClarification for other tools (e.g., ambiguous repo names, ambiguous dates).
