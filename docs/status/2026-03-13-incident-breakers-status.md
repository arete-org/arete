# Incident Queue And Breakers Status

## Last Updated

2026-03-27

## Purpose

Track the live incident queue state and the remaining breaker roadmap work.

This status file is operational and can change quickly. Architecture and decision docs remain the durable source for design intent.

## Queue Reconciliation (Now)

Local incident DB reviewed: `C:\Users\Jordan\Desktop\footnote\data\incidents.db`

Current queue snapshot:

- `68432fa8` -> `new` (remediation already `applied`)
- `97f51680` -> `resolved`

Queue hygiene action taken on 2026-03-27:

- Added `incident.note_added` audit event to `68432fa8` with rationale: parked pending operator disposition because remediation is already applied and final review outcome still requires human decision.

Why this is parked (not force-resolved):

- The remaining decision is governance: choose `confirmed`, `dismissed`, or `resolved` after operator review.
- Auto-resolving without that decision would hide unresolved review intent.

## Implementation Reality Check

### Incident reporting and review (Wave 1)

Status: Implemented

Implemented in backend:

- Incident report/list/detail/status/notes/remediation internal APIs in `packages/backend/src/handlers/incidents.ts`
- Durable incident workflow and audit orchestration in `packages/backend/src/services/incidents.ts`
- SQLite incident storage, pseudonymization, and audit persistence in `packages/backend/src/storage/incidents/`

Implemented in Discord bot:

- Consented report flow and remediation persistence in `packages/discord-bot/src/utils/response/incidentReporting.ts`
- Private superuser `/incident` list/view/status/note tooling in `packages/discord-bot/src/commands/incident.ts`
- Shared incident API client wiring in `packages/discord-bot/src/api/incidents.ts`

Canonical structured incident events currently emitted by backend:

- `incident.created`
- `incident.status_changed`
- `incident.remediated`

### Deterministic breakers (Wave 2)

Status: Not implemented yet

- No finalized deterministic `evaluateRiskAndBreakers` authority path is wired as the final response gate.

### Alerts (Wave 3)

Status: Deferred

- Alert transport and notification policy work is still intentionally deferred.

## Remaining Work

- Operator chooses final disposition for incident `68432fa8` (`confirmed`/`dismissed`/`resolved`) and records rationale.
- Breaker implementation work remains open after incident operations are fully stabilized.
