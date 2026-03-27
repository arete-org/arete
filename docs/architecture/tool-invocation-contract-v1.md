# Tool Invocation Contract v1

## Scope

This contract standardizes tool behavior across three boundaries:

1. Planner intent (`ToolInvocationIntent`)
2. Orchestrator eligibility decision (`ToolInvocationRequest`)
3. Runtime outcome (`ToolExecutionContext`)

Contract source of truth:

- `packages/contracts/src/ethics-core/types.ts`

Backend remains authoritative for provenance, trace, and cost semantics.

## Canonical Outcome States

`ToolExecutionContext.status` uses:

- `executed`
- `skipped`
- `failed`

When `status` is `skipped` or `failed`, `reasonCode` must be present.

Tool-oriented `reasonCode` values:

- `tool_not_requested`
- `tool_not_used`
- `tool_unavailable`
- `tool_execution_error`
- `search_not_supported_by_selected_profile`
- `unspecified_tool_outcome`

## Mapping Rules

Planner to orchestrator:

1. If `generation.search` is absent, emit `ToolInvocationIntent` with `requested=false`.
2. If `generation.search` is present, emit `ToolInvocationIntent` with:
   `toolName="web_search"`, `requested=true`, and serializable input (`query`, `intent`, `contextSize`, optional `repoHints`).

Orchestrator to runtime:

1. Start with `ToolInvocationRequest`:
   `requested=true` + `eligible=true` when planner requested search.
2. If selected profile cannot search and reroute is not allowed/available:
   set `eligible=false` + `reasonCode="search_not_supported_by_selected_profile"` and do not send `search` to runtime.
3. If provider lacks mapped search tool support at runtime adapter:
   set outcome to `skipped` + `reasonCode="tool_unavailable"` (fail-open generation continues).

Runtime to metadata:

1. Runtime may emit `GenerationResult.toolExecution`.
2. Backend may override with stricter orchestrator policy outcomes.
3. Final trace metadata records tool outcome in `ResponseMetadata.execution[]` (`kind="tool"`).

## Example Metadata Payloads

Success path (`executed`):

```json
{
    "execution": [
        {
            "kind": "tool",
            "status": "executed",
            "toolName": "web_search",
            "durationMs": 42
        }
    ]
}
```

Fail-open path (`skipped` due eligibility):

```json
{
    "execution": [
        {
            "kind": "tool",
            "status": "skipped",
            "toolName": "web_search",
            "reasonCode": "search_not_supported_by_selected_profile"
        }
    ]
}
```

Fail-open path (`skipped` due runtime adapter support gap):

```json
{
    "execution": [
        {
            "kind": "tool",
            "status": "skipped",
            "toolName": "web_search",
            "reasonCode": "tool_unavailable"
        }
    ]
}
```
