# File Scanning Context Integration

This document describes the backend-owned `file_scan` context integration.

`file_scan` runs in workflow context-step execution and provides attachment
grounding signals before generation. It is advisory and fail-open.

## Scope

`file_scan` currently handles:

- image attachments (via backend image-description task service)
- non-image attachments (as typed attachment context metadata)

It does not grant terminal authority or policy authority.

## Execution model

`file_scan` is emitted through planner application when chat attachments are
present. The workflow engine executes it through the context-step executor
registry.

### Behavior

- Requested + eligible with attachments: executes and returns context messages
  and citation-style sources.
- Requested + eligible with no attachments: skipped with `tool_not_used`.
- Not requested or not eligible: skipped with `tool_not_requested` (or incoming
  reason code).

## Fail-open semantics

If image-description execution fails for an attachment, the integration logs a
warning, emits a degraded attachment message, and continues execution.

Generation is not blocked by file scanning failures.

## Provenance and sources

`file_scan` outputs `sources` entries in context-step results so downstream
metadata can include attachment influence in citations/provenance surfaces.
