# Backend Tools Contract

This folder owns backend tool policy and tool wiring.

## Adapter Contract

A backend tool adapter should:

1. Expose a stable tool name.
2. Accept backend-normalized input.
3. Execute fail-open.
4. Return serializable result context for:
    - prompt injection
    - execution telemetry (`toolName`, `status`, `reasonCode`, `durationMs`)
5. Keep provider-specific parsing and guards inside the adapter.

## Selection Policy

Current precedence:

1. `weather_forecast`
2. `web_search`

If both are requested in one plan, policy applies single-tool behavior and drops `web_search`.

## Telemetry Semantics

Tool wiring should always produce consistent metadata shapes:

- `toolIntent`: planner-facing request intent
- `toolRequest`: orchestrator eligibility decision
- `toolExecution`: runtime outcome

All fields must remain serializable and backend-owned.

## Known Test Environment Notes

Some full-suite tests depend on runtime environment/config state:

- CAPTCHA auth tests mutate `process.env` and `globalThis.fetch` and run with file-local non-concurrency to avoid cross-test interference.
- Ollama routing tests skip when no enabled ollama profile is present in active runtime config.
