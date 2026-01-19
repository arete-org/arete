# Ethics Core Risk Evaluation & Circuit Breakers

## Purpose

Add **incident logging** and **deterministic circuit breakers**.

This milestone establishes:

- a user-facing way to **report Ari messages** (with consent),
- a private, durable **incident record** (SQLite on Fly volume),
- and an ethics-core-owned **risk evaluation + breaker action** layer that gates responses.

---

### Rules

- Ethics-core is the **final decider** for breaker actions. The planner may “suspect” but is non-authoritative.
- **Fail open** by default (pipeline should degrade gracefully), except where a breaker rule explicitly requires refusal.
- Prefer **pseudonymized** identifiers and **minimal retained content**.
- Add only the **structured event logs** needed to audit incidents and breaker trips; avoid a full logging rewrite.

---

## What exists today

- Provenance footer includes a “Report Issue” entry point, but it is a stub.
- SQLite trace store exists and is written per-response (provenance).
- ethics-core has RiskTier/types, but risk evaluation is stubbed/unwired.
- Superuser concept is minimal (developer env ID only).
- Logging is Winston-based with partial privacy coverage, but not event-structured for incidents/breakers.

(Assume code is source of truth; this doc is a working plan.)

---

## Phase 1 — IncidentStore (SQLite) + audit events

**Goal:** Create first-class durable incident records with lifecycle and append-only audit trail.

**Key tasks**

- Add an IncidentStore module in `shared` (or similar) using better-sqlite3.
- Create tables:
    - `incidents` (status, tags, pointers, timestamps, remediation flags)
    - `incident_audit_events` (incident_id, actor_hash, action, notes, timestamp)

- Add store factory wiring next to trace store factory.

**Deliverable:** `IncidentStore` can create incidents, update status, and append audit events; schema auto-inits on boot.

---

## Phase 2 — Pseudonymization utilities

**Goal:** Ensure incident persistence and incident logs never store raw Discord identifiers.

**Key tasks**

- Implement `hmacId(secret, rawId)` helper (HMAC-SHA256 recommended).
- Apply hashing for: reporter, guild, channel, message IDs (and any “actor” identity in audit events).
- Add tests to prevent regressions (no raw IDs in incident DB rows or incident logs).

**Deliverable:** Pseudonymization is used consistently across incident creation, auditing, and alert payloads.

---

## Phase 3 — Report submission UX (Discord-only, consented)

**Goal:** Replace the “Report Issue” stub with a real report flow.

**Key tasks**

- Interaction flow:
    - click “Report Issue” → explicit consent step (“I consent” / “Cancel”)
    - optional inputs (tags, description, contact) via modal/selects

- Auto-capture context:
    - message jump link + message ID pointers
- provenance pointers when available (responseId / model hash / chain hash)

- Store report as `status = new` and append an `incident.created` audit event.

**Deliverable:** Reporting creates a durable incident record with consent and captured pointers, without requiring user copy/paste.

---

## Phase 4 — Immediate remediation (edit reported Ari message)

**Goal:** When Ari is reported, edit the target message to add a warning and spoiler/obscure content.

**Key tasks**

- Implement idempotent “mark message under review” helper:
    - detect existing marker and skip if already remediated
    - apply spoiler wrapping or safe placeholder for long/edge cases

- Record remediation applied + timestamp on the incident.

**Deliverable:** A reported Ari message is reliably edited once, with remediation tracked.

---

## Phase 5 — Superuser review tooling (private)

**Goal:** Allow maintainers (and later moderators) to review and manage incidents privately.

**Key tasks**

- Add superuser allowlist via `.env` (CSV of IDs) and enforce on commands.
- Commands:
    - list (filters: status/date/tag)
    - view (details + pointers)
    - update status (reviewed/confirmed/dismissed/resolved)
    - add internal note (audit event)

**Deliverable:** Superusers can triage incidents end-to-end; every action is auditable.

---

## Phase 6 — Alerts (Discord ping + admin email)

**Goal:** Notify maintainers when new incidents arrive (and/or when confirmed).

**Key tasks**

- Add env-configured alert targets:
    - Discord channel/role mention
    - SMTP email recipient(s)

- Payload must be redacted:
    - include incident short ID, tags/status, jump link, provenance pointers
    - exclude raw content and raw IDs

**Deliverable:** Alerts can be enabled/disabled by config, and are safe by default.

---

## Phase 7 — ethics-core risk evaluation (deterministic) + breaker rules

**Goal:** Make ethics-core the authoritative engine for risk evaluation and breaker actions.

**Key tasks**

- Replace stubs with:
    - deterministic classification of content categories (starter set)
    - mapping to actions (block / redirect / safe partial / ask for human review)
    - stable `ruleId` output for audit/logging

- Accept “planner suspicion” as optional hints, but do not depend on it for safety.

**Deliverable:** `evaluateRiskAndBreakers(input) -> { riskTier, action, ruleId, notes }` is stable and testable.

---

## Phase 8 — Enforcement hook in message pipeline

**Goal:** Apply breaker results before sending a response.

**Key tasks**

- In `MessageProcessor` (or equivalent), insert:
    1. build evaluation input
    2. run ethics-core evaluation
    3. apply breaker action (refuse/redirect/rewrite/allow)

- Ensure provenance reflects breaker action (where applicable).

**Deliverable:** Breaker actions deterministically gate responses; planner output cannot bypass it.

---

## Phase 9 — Minimal structured events (incidents + breakers)

**Goal:** Add structured log events for auditing and debugging.

**Key tasks**

- Emit compact JSON events (privacy-safe) for:
    - `incident.created`
    - `incident.remediated`
    - `incident.status_changed`
    - `breaker.tripped`

- Include correlation fields: incidentId (short), responseId when available, ruleId, action.

**Deliverable:** Incidents and breaker trips are grep-able, correlatable, and privacy-preserving.
