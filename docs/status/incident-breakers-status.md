# Incident And Breakers Status

## Last Updated

2026-03-13

## Purpose

Track implementation progress for incident reporting and deterministic breaker work.

This file is expected to change. Architecture and ADR documents should stay stable.

## Summary

The storage and privacy foundation is ahead of the old milestone document.

The end-to-end incident workflow and deterministic breaker enforcement are still incomplete.

## Status By Workstream

### 1. Incident store and audit trail

Status: Partial

What exists:

- SQLite incident schema and audit schema exist.
- Incident creation, status updates, and audit appends exist.
- Env-based incident store factory exists.

Evidence:

- `packages/backend/src/storage/incidents/sqliteIncidentStore.ts`
- `packages/backend/src/storage/incidents/incidentStore.ts`

Gap:

- The incident store is not wired into a production report flow yet.
- I did not find production call sites creating incidents outside tests.

### 2. Pseudonymization and privacy-safe logging

Status: Partial

What exists:

- HMAC pseudonymization helpers exist.
- Incident storage pseudonymizes guild, channel, message, and actor IDs.
- Logger redacts Discord snowflakes in structured data.
- Tests cover incident persistence and log redaction.

Evidence:

- `packages/backend/src/utils/pseudonymization.ts`
- `packages/backend/test/incidentStore.test.ts`
- `packages/discord-bot/src/utils/logger.ts`
- `packages/discord-bot/test/loggingPrivacy.test.ts`

Gap:

- Alert payload redaction is not implemented because alerting does not exist yet.

### 3. Discord report submission UX

Status: Incomplete

What exists:

- Provenance controls render a `report_issue` button.
- The click handler logs the action and replies with a stub message.

Evidence:

- `packages/discord-bot/src/utils/response/provenanceCgi.ts`
- `packages/discord-bot/src/index.ts`

Gap:

- No consent step.
- No modal or selects.
- No incident creation.
- No `incident.created` audit event.

### 4. Immediate remediation

Status: Incomplete

What exists:

- No dedicated remediation helper found.

Gap:

- No message edit flow.
- No idempotent under-review marker.
- No remediation timestamp tracking.

### 5. Superuser review tooling

Status: Partial

What exists:

- There is a single developer user concept in Discord bot config.

Evidence:

- `packages/discord-bot/src/config/runtime.ts`

Gap:

- No CSV superuser allowlist.
- No incident review commands.
- No auditable moderator workflow.

### 6. Alerts

Status: Incomplete

What exists:

- No incident-specific Discord alerting or SMTP alerting implementation found.

Gap:

- No alert targets.
- No redacted incident alert payloads.
- No enable or disable controls.

### 7. Deterministic ethics-core evaluation

Status: Partial

What exists:

- Shared `RiskTier` and metadata contracts exist.
- The planner normalizes a `riskTier` field from model output.
- Reflect service can raise response metadata to the planner-provided tier.

Evidence:

- `packages/contracts/src/ethics-core/types.ts`
- `packages/backend/src/services/reflectPlanner.ts`
- `packages/backend/src/services/reflectService.ts`

Gap:

- `computeProvenance` and `computeRiskTier` are still stubs.
- There is no deterministic `evaluateRiskAndBreakers` API.
- There is no stable breaker `ruleId` output.

### 8. Breaker enforcement in the pipeline

Status: Incomplete

What exists:

- `MessageProcessor` has a central execution point for backend reflect responses.

Evidence:

- `packages/discord-bot/src/utils/MessageProcessor.ts`

Gap:

- No explicit breaker evaluation step before sending the response.
- No refusal or redirect path owned by ethics-core.
- No provenance field showing a breaker action was applied.

### 9. Structured incident and breaker events

Status: Partial

What exists:

- Logging has privacy redaction.
- Incident store emits ordinary informational logs when incidents or audit events are written.

Evidence:

- `packages/discord-bot/src/utils/logger.ts`
- `packages/backend/src/storage/incidents/sqliteIncidentStore.ts`

Gap:

- No canonical event names such as `incident.created` or `breaker.tripped`.
- No correlation payload standard for `incidentId`, `responseId`, `ruleId`, and action.

## Current Invariants

These are the most important truths the current code already depends on:

- raw Discord IDs should not be persisted in incident storage,
- incident audit events should remain append-only,
- planner-supplied risk tier is not a deterministic breaker system,
- report issue is still a stub and should not be described as fully implemented.

## Realistic Failure Modes

- A maintainer assumes incident reporting works end to end because the button is visible.
- A caller starts using the incident store directly without adding audit events consistently.
- A future safety review mistakes planner risk metadata for an enforced breaker layer.
- Logs become harder to correlate because event naming is still ad hoc.

## Validation And Review Checks

Checks that currently help:

- `packages/backend/test/incidentStore.test.ts`
- `packages/discord-bot/test/loggingPrivacy.test.ts`

Checks that are still missing for this feature set:

- interaction tests for consented report creation,
- remediation idempotency tests,
- end-to-end tests for breaker enforcement,
- structured event tests for canonical incident and breaker log payloads.
