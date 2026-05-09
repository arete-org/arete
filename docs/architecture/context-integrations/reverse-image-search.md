# Reverse Image Search Context Integration

This document describes the backend-owned `reverse_image_search` context
integration.

`reverse_image_search` runs in workflow context-step execution and provides
advisory public-reference signals for image attachments before generation.
It is bounded and fail-open.

## Scope

`reverse_image_search` currently handles:

- image attachments (reverse lookup against configured provider)
- confidence-gated advisory summaries and bounded source citations

It does not grant terminal authority or policy authority.

## Execution model

`reverse_image_search` is emitted through planner application when:

- reverse-image integration is enabled
- image attachments are present
- planner did not explicitly disable reverse-image lookup
- planner requested it or auto-run-with-image-attachments is enabled

The workflow engine executes it through the context-step executor registry.

## Provider runtime

Runtime config controls whether a provider is available:

- `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_ENABLED`
- `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_AUTORUN`
- `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_MIN_CONFIDENCE_PERCENT`
- `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_MAX_MATCHES_PER_IMAGE`
- `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER` (`none` or `serpapi`)
- `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_SERPAPI_API_KEY` (required for `serpapi`)
- `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER_TIMEOUT_MS`

When provider mode is `none`, the integration stays fail-open unavailable.

## Behavior

- Requested + eligible with no image attachments:
    - skipped with `tool_not_used`
- Requested + eligible with images but no provider:
    - skipped with `tool_unavailable`
- Requested + eligible with images + provider:
    - executed and emits bounded advisory context + citations
- Not requested or not eligible:
    - skipped with `tool_not_requested` (or incoming reason code)

## Confidence handling

Provider confidence is advisory only.

- If confidence is below configured threshold:
    - context reports low confidence and avoids asserting direct matches
- If matches are empty:
    - context reports no confident public matches
- If lookup fails:
    - context logs warning and continues without blocking generation

## Fail-open semantics

Provider/network/parse failures do not block generation.

The integration emits bounded degraded context when possible and returns normal
workflow control to generation.

## Provenance and sources

`reverse_image_search` outputs `sources` entries in context-step results so
downstream metadata can include reverse-lookup influence in citations/provenance
surfaces.
