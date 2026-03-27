# Incident Queue And Breakers Status

## Last Updated

2026-03-27

## Owners

- `packages/backend` (incident workflow and breaker/evaluator behavior)
- `docs` (status maintenance)

## Purpose

Track current incident + breaker status for operations.
Keep this short and aligned with code reality.

Canonical runtime capability reference: [2026-03-27-runtime-capability-matrix.md](./2026-03-27-runtime-capability-matrix.md).

## Snapshot

- Incident storage and pseudonymization foundations are in place.
- Incident report/review workflow APIs are implemented in backend.
- Deterministic breaker rollout is still a focused follow-up area.
- Alert transport and notification policy remain deferred.

## What Is Landed

- Incident report/list/detail/status/notes/remediation APIs.
- Durable incident workflow orchestration and audit trail emission.
- SQLite incident persistence with pseudonymization support.
- Deterministic risk/provenance evaluator metadata in chat orchestration.

## What Is Open

### 1) Integration Pilot

Goal: validate one real integration path with clear provenance and fail-open behavior.

Reference issue: `JBA-18`

### 2) Deterministic Breaker Metadata Parity

Goal: ensure breaker outcomes are explicit and auditable in execution metadata.

Reference issue: `JBA-19`

### 3) Multi-step Workflow Follow-up

Goal: add lineage safely after current single-path hardening is stable.

Reference issue: `JBA-20`

## Guardrails

- Backend stays the runtime boundary and cost authority.
- Public interfaces stay serializable.
- Fail-open remains default except explicit refusal policy paths.
- No migrations/backfills/compat layers unless explicitly requested.

## Validation Focus

- Tool outcome visibility (`executed` / `skipped` / `failed` + reason codes).
- Breaker outcome visibility (`ruleId`, action, and user-safe metadata).
- End-to-end traceability across backend and Discord/web rendering surfaces.
