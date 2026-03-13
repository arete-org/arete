# Incident Storage And Audit

## Purpose

Define the durable incident record and audit trail model.

This document describes what must be stored, what must not be stored, and what guarantees callers can rely on.

## Storage Model

Incident persistence uses a local SQLite database with automatic schema initialization.

The storage layer owns two logical records:

- `incidents`: the current state of each report,
- `incident_audit_events`: append-only audit entries tied to one incident.

## Incident Record

An incident record should contain:

- stable incident ID,
- short operator-facing ID,
- status,
- tags,
- privacy-safe pointers,
- remediation flags and notes,
- created and updated timestamps.

The incident record should not contain broad raw Discord transcript copies by default.

## Audit Event Record

An audit event should contain:

- stable audit event ID,
- incident ID,
- pseudonymized actor identifier when present,
- action name,
- optional notes,
- creation timestamp.

Audit events are append-only. Status changes create new audit events rather than rewriting history.

## Pseudonymization Boundary

The storage layer must pseudonymize Discord identifiers before persistence.

Expected pseudonymized values:

- reporter or actor ID,
- guild ID,
- channel ID,
- message ID.

Expected cleartext values when needed:

- response ID,
- jump URL,
- model version,
- chain hash,
- short free-text notes when explicitly provided.

The system should prefer retaining pointers over content bodies.

## Initialization And Runtime Behavior

The incident store should:

- initialize schema automatically before first use,
- use a durable path in production,
- allow a local fallback path when the default production path is unavailable,
- fail loudly on missing pseudonymization secret,
- fail open at the application layer where possible so unrelated user flows keep working.

## Status Model

The canonical incident lifecycle is:

- `new`
- `under_review`
- `confirmed`
- `dismissed`
- `resolved`

Additional statuses should be added only when they change operator behavior or user-visible semantics.

## Invariants

- Raw Discord identifiers are never persisted in incident rows or audit rows.
- Audit history is append-only.
- Incident rows remain serializable and stable across bot and backend boundaries.
- Status transitions are explicit and auditable.
- Schema initialization is safe to run repeatedly.

## Failure Modes

Realistic failures to design for:

- SQLite path exists but is not writable.
- Busy or locked database causes transient write failures.
- A caller attempts to write an invalid incident status.
- A caller passes already-hashed identifiers and the system double-hashes them.

## Validation Expectations

Checks that should exist or remain in place:

- integration tests that inspect stored SQLite rows for pseudonymized IDs,
- tests for actor hashing in audit events,
- tests for invalid status rejection,
- startup or factory tests for path fallback behavior.

Current code already covers part of this space. The status document should track which checks exist and which are still missing.
