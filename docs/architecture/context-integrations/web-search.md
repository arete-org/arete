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

### Setup quick start

1. Turn on integration:

- `CHAT_CONTEXT_WEB_SEARCH_ENABLED=true`

2. Pick provider order (left to right fallback):

- `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY=searxng,brave,serpapi`

3. Configure at least one provider:

- SearXNG: set `CHAT_CONTEXT_WEB_SEARCH_SEARXNG_BASE_URL`
- Brave: set `CHAT_CONTEXT_WEB_SEARCH_BRAVE_API_KEY`
- SerpAPI: set `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_API_KEY`

4. Set safety/perf bounds:

- `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_TIMEOUT_MS=12000`
- `CHAT_CONTEXT_WEB_SEARCH_MAX_RESULTS=6`

If a provider is in priority but missing credentials/config, it is skipped as
`tool_unavailable` and the next provider is tried.

### Environment variables

| Variable                                                   | What it controls                                                                 | Typical value / notes                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `CHAT_CONTEXT_WEB_SEARCH_ENABLED`                          | Master on/off switch for `web_search` context-step execution.                    | `true` (default). Set `false` to disable integration globally.         |
| `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY`                | Ordered fallback list of providers.                                              | `searxng,brave,serpapi` (default).                                     |
| `CHAT_CONTEXT_WEB_SEARCH_SEARXNG_BASE_URL`                | Base URL for SearXNG API calls.                                                  | Example: `https://searxng.example`                                     |
| `CHAT_CONTEXT_WEB_SEARCH_BRAVE_API_KEY`                   | Brave Search API key.                                                            | Required only if `brave` is in priority and expected to run.           |
| `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_API_KEY`                 | SerpAPI key for web search provider.                                             | Required only if `serpapi` is in priority and expected to run.         |
| `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_ENGINE`                  | Optional SerpAPI engine override.                                                | Defaults to `google` if unset.                                         |
| `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_GL`                      | Optional SerpAPI country hint (`gl`).                                            | Example: `us`                                                          |
| `CHAT_CONTEXT_WEB_SEARCH_SERPAPI_HL`                      | Optional SerpAPI language hint (`hl`).                                           | Example: `en`                                                          |
| `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_TIMEOUT_MS`             | Timeout budget per provider attempt.                                             | `12000` (default). Lower for stricter latency, higher for resilience.  |
| `CHAT_CONTEXT_WEB_SEARCH_MAX_RESULTS`                     | Max normalized results kept from a successful provider response.                 | `6` (default). Keep small to avoid prompt bloat.                       |
| `CHAT_CONTEXT_WEB_SEARCH_OPENAI_NATIVE_FROM_HINTS_ENABLED` | Allows optional OpenAI-native follow-up search from generated `searchHints`.     | `true` (default). Set `false` for stricter external-provider-only use. |

### Recommended setups

- SearXNG-first self-hosted posture:
  - `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY=searxng,brave,serpapi`
  - Set SearXNG base URL, keep Brave/SerpAPI as commercial fallback.
- API-only posture (no SearXNG):
  - `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY=brave,serpapi`
  - Set Brave and/or SerpAPI keys.
- SerpAPI-focused posture:
  - `CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY=serpapi`
  - Set SerpAPI key and optional `ENGINE/GL/HL`.

Missing provider credentials should degrade to `tool_unavailable` for that
provider attempt, not block the request.

## Operator and review expectations

- Keep env parser behavior and config-spec definitions aligned for every
  `CHAT_CONTEXT_WEB_SEARCH_*` variable.
- Keep provider outcomes visible via attempt metadata and reason codes.
- Keep provider output bounded and serializable for trace/provenance surfaces.
