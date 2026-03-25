# Incident And Breakers Status

## Last Updated

2026-03-13

## Purpose

Track the current plan for incident reporting, review, and deterministic breaker work.

This file should change as the work moves. The architecture and decision docs should stay more stable.

## Current State

The storage and privacy groundwork is ahead of the original milestone draft, but the real reporting flow and breaker enforcement are not built yet.

Assumptions for this plan:

- incident persistence and review state live in the backend
- Discord is the first reporting surface
- review tooling will exist both as backend admin APIs and Discord superuser commands
- internal incident APIs reuse the existing trusted service-auth pattern
- breaker work starts after the incident flow is real
- alerts wait until incident creation and review are stable

### What we already have

- Incident SQLite schema, status updates, and audit append primitives in `packages/backend/src/storage/incidents/`
- Pseudonymization helpers in `packages/backend/src/utils/pseudonymization.ts`
- Discord ID redaction in `packages/discord-bot/src/utils/logger.ts`
- A `report_issue` provenance button in `packages/discord-bot/src/utils/response/provenanceCgi.ts`
- A stub click handler in `packages/discord-bot/src/index.ts`
- Shared risk metadata contracts, but not a real deterministic ethics-core evaluator

### Validation baseline

Already in place:

- `packages/backend/test/incidentStore.test.ts`
- `packages/discord-bot/test/loggingPrivacy.test.ts`

Still missing:

- consented report-flow interaction tests
- remediation idempotency tests
- admin review command tests
- structured incident-event tests
- breaker rule unit tests
- end-to-end breaker enforcement tests

## Working Plan

### Wave 1: Incident Flow First

Goal: ship a real incident workflow before breaker work starts.

#### 1A. Backend incident APIs and startup wiring

Status: Planned

- backend incident APIs for report creation, list, detail, status update, and internal notes
- shared contract types and schemas in `packages/contracts/src/web`
- incident store startup initialization, instead of relying only on lazy first use

Acceptance:

- backend is the only source of truth for incident state
- schema tests cover each new endpoint
- integration tests cover SQLite incident storage

#### 1B. Discord consented report flow

Status: Planned

- replace the `report_issue` stub with an ephemeral consent flow
- collect optional tags, description, and contact text
- submit the report to the backend and return a clear success or failure reply

Depends on:

- Wave 1A

Acceptance:

- no incident row is created without explicit user consent
- interaction tests cover consent, cancel, submit, and storage-failure paths
- integration tests assert row counts correctly

#### 1C. Immediate remediation

Status: Planned

- an idempotent helper that marks a reported assistant message as under review
- warning text plus spoiler wrapping where possible
- a safe fallback when editing the original content directly is risky
- remediation persistence and `incident.remediated` only when a new remediation actually happens

Depends on:

- Wave 1B

Acceptance:

- repeated reports do not stack duplicate warning banners
- edits do not corrupt the original assistant message body
- tests cover already-marked, long, and awkward content cases

#### 1D. Review tooling

Status: Planned

- a real CSV superuser allowlist in bot runtime config
- backend admin APIs for list, detail, status change, and internal notes
- private Discord `/incident` review commands that call those APIs

Depends on:

- Wave 1A

Acceptance:

- every moderator action creates an audit event
- tests cover allowlist enforcement and Discord command behavior
- integration tests assert audit rows for status changes and notes

#### 1E. Canonical incident events

Status: Planned

- privacy-safe structured events for `incident.created`, `incident.remediated`, and `incident.status_changed`
- shared correlation fields such as `incidentId`, `responseId`, `status`, and action

Depends on:

- Waves 1A through 1D

Acceptance:

- logs are usable for tracing one incident end to end
- raw Discord identifiers do not appear in event payloads
- logger tests cover event names, correlation fields, and redaction

### Wave 2: Narrow Deterministic Breakers

Goal: make ethics-core the final authority for a small, testable first breaker set.

#### 2A. Deterministic evaluation API

Status: Planned

- `evaluateRiskAndBreakers(input) -> { riskTier, action, ruleId, notes }`
- a narrow first rule set:
    - self-harm or crisis escalation
    - dangerous weaponization or explicit harm enablement
    - one tightly scoped high-risk advice family

Notes:

- nothing blocks this technically, but it should come after Wave 1

Acceptance:

- planner risk remains a hint, not the final breaker authority
- rule-by-rule unit tests exist
- evaluator contract tests cover `ruleId`, action, and notes

#### 2B. Reflect pipeline enforcement

Status: Planned

- run deterministic evaluation before final response emission in the backend reflect path
- apply `allow`, `block`, `redirect`, `safe_partial`, or `human_review`
- add optional breaker metadata to response metadata
- emit `breaker.tripped` for non-allow outcomes

Depends on:

- Wave 2A

Acceptance:

- planner output cannot bypass breaker results
- integration tests cover blocked and redirected outcomes
- response metadata remains compatible with current consumers

### Wave 3: Alerts

Goal: add notifications only after incident creation and review are stable.

Status: Deferred

- redacted Discord alert targets and SMTP alert targets
- alerts for new incidents and optionally confirmed incidents
- payloads with short IDs and safe pointers only

Depends on:

- stable outputs from Wave 1

Acceptance:

- alerts do not include raw IDs or broad raw content by default
- tests cover payload redaction and enabled/disabled config paths
