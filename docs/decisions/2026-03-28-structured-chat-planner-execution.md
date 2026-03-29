# Structured Chat Planner Execution (A-D)

## Context

Planner execution has been failing on formatting drift (`planner_invalid_output`) because planner output was treated as free-form text JSON parsing.

## Decision

Adopt a backend-owned structured planner protocol with OpenAI Responses function calling, keep fail-open behavior, and demote legacy text parsing to an explicit fallback mode.

## Scope By Milestone

### A. Contract and interface

- Added canonical planner decision contract in:
    - `packages/backend/src/services/chatPlannerDecisionContract.ts`
- Added OpenAI structured planner executor in:
    - `packages/backend/src/services/chatPlannerStructuredOpenAi.ts`
- Added runtime config controls:
    - `PLANNER_STRUCTURED_OUTPUT_ENABLED` (default `true`)
    - `PLANNER_ALLOW_LEGACY_TEXT_FALLBACK` (default `false`)

### B. OpenAI structured path behind flag

- `chatOrchestrator` now wires the structured planner executor when:
    - structured planner is enabled
    - planner profile provider is `openai`
    - `OPENAI_API_KEY` is configured
- `chatPlanner` consumes structured decisions directly and only uses legacy text parsing when explicitly allowed.

### C. Telemetry and rollout hooks

- Planner fallback logs now include `failureClass`:
    - `runtime_error`
    - `schema_invalid`
    - `policy_invalid`
- Added explicit `chat.planner.structured_fallback` log event when structured execution fails and legacy fallback is attempted.

### D. Legacy parser retirement posture

- Legacy text parser hardening behavior is no longer the primary path.
- Legacy execution is now a controlled fallback mode, disabled by default.
- This keeps emergency recovery available while making structured execution authoritative.

## Rollout Policy

1. Keep `PLANNER_STRUCTURED_OUTPUT_ENABLED=true` in all environments.
2. Keep `PLANNER_ALLOW_LEGACY_TEXT_FALLBACK=false` unless there is a live incident.
3. If fallback is temporarily enabled, monitor `chat.planner.structured_fallback` and switch back off after remediation.
