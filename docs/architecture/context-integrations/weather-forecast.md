# Weather Forecast Integration

This document describes the backend-owned weather context integration used in
chat orchestration.

Integrated tool: `weather_forecast` (provider: Open-Meteo).

## Purpose

The weather integration adds bounded forecast context for requests that need
local weather facts.

It is a context integration, not a policy authority:

- it can provide weather context
- it cannot decide execution policy, terminal authority, or safety posture
- the backend still decides action, routing, and fail-open behavior

## Ownership Boundaries

Backend ownership:

- tool selection and execution gating
- planner normalization and tool-intent validation
- clarification handling and user-facing continuation behavior
- fail-open classification and metadata recording

Provider ownership:

- forecast and geocoding data payloads only

## Runtime Flow

1. Planner emits a bounded tool intent for `weather_forecast`.
2. Orchestrator resolves tool selection and executes the weather adapter.
3. The weather tool returns one of three outcomes:
    - `ok`
    - `error`
    - `needs_clarification`
4. Orchestrator either:
    - injects normalized weather context and continues generation (`ok`)
    - short-circuits to a clarification message (`needs_clarification`)
    - records failure and continues safely where allowed (`error`)

## Mode Coverage

Weather context-step execution currently applies only to the
`bounded-review` profile used by `balanced` and `grounded`.

The `generate-only` profile used by `fast` bypasses the workflow engine, so it
does not use the context-step path. Weather support there would need separate
handling. That split is intentional: the fast path is direct single-pass
generation without the workflow infrastructure that injects context before
generation.

## Outcome Contract

The tool path is intentionally tri-state:

- `ok`: forecast data was fetched and normalized.
- `error`: provider or transport path failed with fail-open-safe classification.
- `needs_clarification`: geocoding produced multiple plausible locations and
  user clarification is required before normal generation.

Clarification options are structured, with stable option IDs and normalized
location inputs for follow-up selection.

## Clarification Behavior

When a tool returns `needs_clarification`, normal generation is skipped for
that turn, the orchestrator returns a user-facing clarification message,
metadata execution includes the tool event with the clarification payload, and
generation execution is recorded as skipped for that response path. This is a
deliberate stop condition for user input, not a failure.

## Fail-Open and Error Semantics

Weather integration is fail-open by default for non-clarification failures.
Timeout, network, HTTP, invalid-response, and location-not-resolved paths are
classified and recorded, and the backend may continue normal response
generation without weather context.

Provider malformation is treated as `invalid_response`, not ambiguity.

## Provenance and Metadata

Normalized tool payloads retain provider-facing provenance fields:

- `provider` - provider identifier (e.g., 'open-meteo')
- `endpoint` - exact API URL used; intended for trace/audit, not user-facing
- `requestedAt` - ISO timestamp of API call
- `resolvedFromEndpoint` - (optional) geocoding endpoint when location was resolved
- `citationUrl` - human-readable provider source URL for user-facing citations
- `citationLabel` - human-readable label for the citation source

The `endpoint` field is useful for debugging and audit trails. The `citationUrl`
and `citationLabel` fields are intended for user-facing attribution.

Tool execution metadata is recorded through backend execution context and
response metadata assembly.

## Integration Surfaces

- `packages/backend/src/services/openMeteoForecastTool.ts`
- `packages/backend/src/services/tools/weatherForecastToolAdapter.ts`
- `packages/backend/src/services/tools/toolRegistry.ts`
- `packages/backend/src/services/chatOrchestrator.ts`

## Validation References

- `packages/backend/test/openMeteoForecastTool.test.ts`
- `packages/backend/test/chatPlanner.test.ts`
- `packages/backend/test/chatService.test.ts`
- `packages/backend/test/chatOrchestrator.test.ts`
