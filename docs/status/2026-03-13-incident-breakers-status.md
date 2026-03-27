# Incident And Breakers Status

## Last Updated

2026-03-27

## Purpose

Track current status for incident/reporting and deterministic breaker work.

Keep this file short and current.

## Snapshot

- Incident storage and pseudonymization foundations are in place.
- Runtime/tooling architecture groundwork has moved forward quickly.
- Deterministic breaker rollout is still a focused follow-up area.

## What Is Landed

- Incident SQLite storage primitives and audit append support.
- Discord ID redaction in bot logging paths.
- Shared risk/provenance metadata contracts.
- Runtime metadata and tool-governance groundwork from recent merged work.

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
