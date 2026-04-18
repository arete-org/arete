# Weather.gov Tool Pilot Eval (2026-03-27)

## Scope

Pilot goal: validate one backend-owned, read-only weather tool path end-to-end with fail-open behavior.

Integrated tool: `weather_forecast` (`weather.gov`).

## Explicit Eval Set (8 prompts)

1. `Forecast for 39.7684,-86.1581 for next 3 periods.`
2. `Give me weather at 47.6062,-122.3321 for 8 periods.`
3. `Weather for 25.7617,-80.1918 (short horizon).`
4. `Forecast for office IND grid 56,69 for next 4 periods.`
5. `What is the weather in Indianapolis?` (no coordinates; tool should be omitted)
6. `Use weather for 39.7392,-104.9903 and summarize precipitation risk.`
7. `Forecast at invalid location payload` (planner emits invalid shape; normalization should drop tool request)
8. `Force weather adapter failure and continue normal response flow.`

## Comparison Frame

- **Without tool path**: normal model generation only.
- **With tool path**: backend injects normalized weather tool result when planner emits valid `generation.weather`.

Primary quality checks:

- Specificity of forecast details.
- Internal consistency of temperatures/horizon periods.
- Provenance visibility in tool payload (`provider`, `endpoint`, `requestedAt`).
- Graceful degradation on timeout/error.

## Local Validation Evidence

- Tool adapter normalization + resiliency tests:
    - `packages/backend/test/weatherGovForecastTool.test.ts`
- Planner weather contract normalization tests:
    - `packages/backend/test/chatPlanner.test.ts`
- Chat-service tool metadata preservation test:
    - `packages/backend/test/chatService.test.ts`
- Orchestrator weather integration + forced-failure fail-open tests:
    - `packages/backend/test/chatOrchestrator.test.ts`

## Quality Summary

- Tool-enabled path provides structured forecast facts and explicit provenance metadata for downstream generation.
- Invalid or missing weather location contracts are disabled safely before runtime execution.
- Forced-failure path is fail-open: generation continues and tool execution is recorded as `failed` with `tool_execution_error`.

## Recommendation

**Expand** to the next pilot iteration, with two adjustments:

1. Add a lightweight, deterministic trigger guard so weather requests are only planned when user intent is clearly forecast-oriented.
2. Add one comparative QA run in staging that scores outputs with and without weather tool context on this eval set.
