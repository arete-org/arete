# Incident Queue And Breakers Status

## Last Updated

2026-03-27

## Owners

- `packages/backend` (incident workflow and breaker/evaluator behavior)
- `docs` (status maintenance)

## Purpose

Track current incident + breaker status for operations. Keep this short and aligned with code reality.

Canonical runtime capability reference: [2026-03-27-runtime-capability-matrix.md](./2026-03-27-runtime-capability-matrix.md).

## Current State

### Incident reporting and review

Status: Implemented

Backend currently ships:

- Incident report/list/detail/status/notes/remediation APIs
- Durable incident workflow orchestration and audit trail emission
- SQLite incident persistence with pseudonymization support

### Deterministic breakers

Status: Partial (observe-only)

Backend currently ships:

- Deterministic risk and provenance evaluators
- Evaluator execution metadata in chat orchestration

Not yet shipped:

- Final breaker enforcement gate that can deterministically block/redirect/safe-partial before response emission

### Alerts

Status: Deferred

- Alert transport and notification policy remain intentionally deferred.

## Known Gaps

- Breaker decisions are not yet the final response gate.
- Architecture target in `docs/architecture/risk-evaluation-and-breakers.md` is ahead of runtime enforcement reality.

## Next Gates

1. Wire deterministic breaker action enforcement in chat orchestration.
2. Keep incident audit semantics stable while breaker enforcement is introduced.
3. Revisit alert transport only after breaker enforcement behavior is stable.
