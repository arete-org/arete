# Web Search Context Integration

This document describes the backend-owned `web_search` context integration.

`web_search` runs as a workflow context step. It provides bounded, advisory
search context before generation and keeps provider behavior visible in
provenance-friendly metadata.

## Purpose and boundary

`web_search` helps with current facts and source discovery. It does not grant
direct authority to external providers.

- Providers can return candidate records (`title`, `url`, optional `snippet`).
- Footnote decides how those records are used.
- If provider calls fail, workflow keeps fail-open behavior and continues
  without blocking the base response path.

Search discovery is not source reading. Results are candidate sources, not
verified evidence by themselves.

## Runtime shape

`chatOrchestrator` injects `web_search` into workflow context-step execution.
`workflowEngine` executes it before `generate` when requested and eligible.

Provider attempts are deterministic by configured priority and recorded as
attempt metadata:

- provider name
- status (`executed_with_results`, `executed_empty`, `skipped`, `failed`)
- reason code (when skipped/failed)
- duration and result count

If no provider returns records:

- all skipped -> `skipped/tool_unavailable`
- any failed -> `failed/tool_execution_error`
- otherwise -> `skipped/tool_not_used`

## Provider model

Supported providers:

- `searxng`
- `brave`
- `serpapi`

Default priority:

- `searxng,brave,serpapi`

All providers normalize into the same source schema and untrusted context
message format to keep downstream behavior provider-neutral.

Current SerpAPI mapping for web search:

- `organic_results[].link` -> normalized `url` (http/https only)
- `organic_results[].title` -> `title`
- `organic_results[].snippet` -> optional `snippet`

## Configuration

Web-search runtime controls:

- `CHAT_CONTEXT_WEB_SEARCH_ENABLED`
- `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY`
- `CHAT_CONTEXT_WEB_SEARCH_SEARXNG_BASE_URL`
- `CHAT_CONTEXT_WEB_SEARCH_BRAVE_API_KEY`
- `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_API_KEY`
- `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_ENGINE`
- `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_GL`
- `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_HL`
- `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_TIMEOUT_MS`
- `CHAT_CONTEXT_WEB_SEARCH_MAX_RESULTS`
- `CHAT_CONTEXT_WEB_SEARCH_OPENAI_NATIVE_FROM_HINTS_ENABLED`

Missing provider credentials should degrade to `tool_unavailable` for that
provider attempt, not block the request.

## Operator and review expectations

- Keep env parser behavior and config-spec definitions aligned for every
  `CHAT_CONTEXT_WEB_SEARCH_*` variable.
- Keep provider outcomes visible via attempt metadata and reason codes.
- Keep provider output bounded and serializable for trace/provenance surfaces.
