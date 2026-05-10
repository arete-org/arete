# Langfuse Metadata Mirror

This page documents Footnote's optional Langfuse metadata mirror.

## Purpose

Give maintainers a cross-run observability view in Langfuse without changing
Footnote's execution authority, provenance semantics, or prompt ownership.

## Key Concepts

- Metadata mirror means Footnote sends a second, best-effort copy of selected
  run metadata to Langfuse.
- Footnote trace is still the canonical product trace.
- Langfuse is observer-only in this integration.
- Default is off.
- Export is fail-open.

## Ownership Boundaries

- Backend owns response execution, policy, provenance, trace semantics, and
  cost authority.
- Langfuse receives a bounded metadata projection only.
- Prompt management is out of scope for this integration.
- Raw user content, raw assistant output, planner payloads, tokens, and secrets
  are out of scope for export.

## Typical Flow

1. Backend assembles and stores canonical `ResponseMetadata` locally.
2. Trace persistence path invokes optional metadata mirror hook.
3. Mirror exporter sends a metadata-only payload to Langfuse ingestion.
4. If export fails, backend logs a warning and continues normally.

The write order is intentional: local trace persistence comes first.

## Configuration

Env keys:

- `LANGFUSE_METADATA_MIRROR_ENABLED`
- `LANGFUSE_METADATA_MIRROR_BASE_URL`
- `LANGFUSE_METADATA_MIRROR_PUBLIC_KEY`
- `LANGFUSE_METADATA_MIRROR_SECRET_KEY`
- `LANGFUSE_METADATA_MIRROR_TIMEOUT_MS`

## Failure Modes

- Disabled or partially configured mirror: no export attempt.
- Langfuse timeout/network/HTTP failure: warning log only.
- Mirror failure does not block response execution or trace persistence.

## How To Test

- Set `LANGFUSE_METADATA_MIRROR_ENABLED=true` with valid Langfuse credentials
  and verify exporter warnings are absent on successful requests.
- Force an invalid endpoint and verify:
    - chat and trace flows still succeed,
    - a mirror warning is logged.
- Run backend tests for config + exporter + trace-store fail-open behavior.

## Related Pages

- [Workflow](./workflow.md)
- [Prompt Resolution Order](./prompt-resolution.md)
- [Incident Handling](./incident-handling.md)
- [Context Integrations](./context-integrations/README.md)
