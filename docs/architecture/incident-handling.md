# Incident Handling

This describes Footnote incident handling behavior today.
It explains how a user report becomes a durable incident record, what data is
stored, what stays out of storage, and what operators can rely on afterward.

Incident handling has to answer a few questions:

- how does a user report one assistant message?
- when can the system create a durable record?
- what must be stored, and what must not be stored?
- how do audit history and status changes work?
- what logging and alerting can happen without blocking the main request flow?

Keep the layers separate:

1. Reporting gathers consent and stable pointers.
2. Storage persists the incident and audit history.
3. Remediation is related, but separate.
4. Logging and alerts describe what happened afterward.

## Scope

This flow covers:

- a user choosing to report one assistant response
- explicit consent before any durable record is created
- optional user-supplied context
- automatic capture of stable pointers
- durable incident storage and append-only audit history
- optional follow-on remediation of the reported assistant message
- structured logging and optional alert fan-out

## Reporting flow

The user-facing reporting flow is intentionally narrow.

1. A user selects the reporting control on one assistant response.
2. The system presents a private consent step.
3. If the user declines, the flow stops and no incident is created.
4. If the user consents, the system may collect optional user context.
5. The system creates one durable incident record with captured pointers.
6. The user gets confirmation that the report was recorded.
7. If policy requires immediate remediation, the reported assistant message can
   be marked as under review.

Reporting one message should create at most one incident for one completed
submission action.

## Required captured context

Incident reporting should capture pointers instead of broad content copies
whenever possible.

Required pointers:

- assistant message id
- channel id
- guild id when present
- message jump URL when available
- response id when available
- provenance pointers such as `chainHash` and `modelVersion` when available

Optional user-provided context:

- tags
- short description
- contact handle or reply preference

The default posture is simple: keep the record useful for operators without
turning it into a transcript store.

## Consent rules

The system must not create a durable incident record until the user explicitly
consents.

Consent must be:

- specific to the selected assistant message
- private to the reporting user
- recorded as part of the incident audit trail

Canceling the flow must leave no durable incident row behind.

## Storage model

Incident persistence uses a local SQLite database with automatic schema
initialization.

The storage layer owns two logical records:

- `incidents` for the current state of each report
- `incident_audit_events` for append-only history tied to one incident

The storage layer should initialize schema automatically before first use, use
a durable production path when available, and allow a local fallback path when
the default path is unavailable.

## Incident record

An incident record should contain:

- a stable incident id
- a short operator-facing id
- status
- tags
- privacy-safe pointers
- remediation flags and notes
- created and updated timestamps

The incident record should not contain broad raw Discord transcript copies by
default.

## Audit event record

An audit event should contain:

- a stable audit event id
- the incident id
- a pseudonymized actor identifier when present
- an action name
- optional notes
- a creation timestamp

Audit events are append-only. Status changes create new audit events instead
of rewriting history.

## Pseudonymization boundary

The storage layer must pseudonymize Discord identifiers before persistence.

These values should be pseudonymized:

- reporter or actor id
- guild id
- channel id
- message id

These values may remain cleartext when needed for debugging or linking:

- response id
- jump URL
- model version
- chain hash
- short free-text notes when the user explicitly provides them

Keep the boundary tight. Prefer retaining pointers over content bodies.

## Status model

The canonical incident lifecycle is:

- `new`
- `under_review`
- `confirmed`
- `dismissed`
- `resolved`

Add more statuses only when they change operator behavior or user-visible
meaning.

## Remediation boundary

Reporting and remediation are related, but they are not the same concern.

The reporting flow may trigger immediate remediation only when:

- the target message is confirmed to be assistant-authored
- the remediation helper is idempotent
- the incident record can show whether remediation happened

Keep incident recording reliable even when remediation is unavailable or
fails.

## Logging contract

Incident lifecycle logging should stay small and structured.

Required incident events:

- `incident.created`
- `incident.updated`
- `incident.resolved`

Backward-compatible incident events that still matter today:

- `incident.status_changed`
- `incident.remediated`

Structured logs should include stable, serializable correlation fields for:

- `conversationId`
- `requestId`
- `incidentId`
- `responseId`

Keep incident logs JSON-serializable. Do not treat logs as a place to dump raw
Discord content or unbounded internal payloads.

## Alert routing

Incident and breaker events can fan out to Discord and email targets. Those
targets are operational side effects. They are not part of the core incident
write path.

Discord alert configuration:

- `INCIDENT_ALERTS_DISCORD_ENABLED`
- `INCIDENT_ALERTS_DISCORD_BOT_TOKEN`
- `INCIDENT_ALERTS_DISCORD_CHANNEL_ID`
- `INCIDENT_ALERTS_DISCORD_ROLE_ID`

Email alert configuration:

- `INCIDENT_ALERTS_EMAIL_ENABLED`
- `INCIDENT_ALERTS_EMAIL_SMTP_HOST`
- `INCIDENT_ALERTS_EMAIL_SMTP_PORT`
- `INCIDENT_ALERTS_EMAIL_SMTP_SECURE`
- `INCIDENT_ALERTS_EMAIL_SMTP_USERNAME`
- `INCIDENT_ALERTS_EMAIL_SMTP_PASSWORD`
- `INCIDENT_ALERTS_EMAIL_FROM`
- `INCIDENT_ALERTS_EMAIL_TO`

## Fail-open behavior

The main application posture stays fail open where possible.

That means:

- unrelated user flows should continue if incident persistence fails
- alert delivery must never block incident writes
- alert delivery must never block normal chat response generation

If alert delivery fails, the system should log a structured warning event with
the delivery channel, alert type, attempted action, and a short error summary.

The storage layer is stricter about privacy configuration. Missing
pseudonymization secret is a real configuration error and should fail loudly in
the store, while the broader application still avoids turning that into a
global outage when possible.

## Invariants

- No durable incident record is created without explicit user consent.
- Raw Discord identifiers are never persisted in incident rows or audit rows.
- Audit history is append-only.
- Status transitions are explicit and auditable.
- Incident rows stay serializable across backend and bot boundaries.
- Reporting captures stable pointers first and minimizes free text.
- User-facing failures in the report flow do not block normal message
  processing outside that flow.
- Schema initialization is safe to run repeatedly.

## Failure modes

Real failures to design for:

- SQLite path exists but is not writable
- transient database lock or busy errors break writes
- a caller attempts to write an invalid incident status
- a caller passes an already-hashed identifier and the system hashes it again
- remediation fails after the incident record is created
- alert delivery fails after the incident record is created

## Validation expectations

This layer should stay covered by:

- integration tests that inspect stored rows for pseudonymized ids
- tests for actor hashing in audit events
- tests for invalid status rejection
- startup or factory tests for path fallback behavior
- flow tests that prove no incident row is created before consent

## Canonical files

If you need the real implementation boundary, start with the backend incident
path:

- [incidents.ts](../../packages/backend/src/handlers/incidents.ts)
- [incidents.ts](../../packages/backend/src/services/incidents.ts)
- [incident storage](../../packages/backend/src/storage/incidents)

If those files disagree with older notes, the code is authoritative.
