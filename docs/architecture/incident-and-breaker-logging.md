# Incident And Breaker Logging

## Purpose

Define the minimal structured logging contract for incident lifecycle events and deterministic breaker outcomes.

## Event Contract

All events in this contract must include:

- `event`: stable event key.
- `correlation`: stable, serializable IDs.
- only JSON-serializable primitives, arrays, and objects.

Correlation shape:

```json
{
    "conversationId": "string|null",
    "requestId": "string|null",
    "incidentId": "string|null",
    "responseId": "string|null"
}
```

## Incident Lifecycle Events

Required events:

- `incident.created`
- `incident.updated`
- `incident.resolved`

Backward-compatible events that remain emitted:

- `incident.status_changed`
- `incident.remediated`

Example `incident.updated`:

```json
{
    "event": "incident.updated",
    "incidentId": "inc_7w2k3m4q",
    "incidentNumericId": 42,
    "responseId": "response_77",
    "status": "under_review",
    "remediationState": "pending",
    "remediationApplied": false,
    "action": "incident.note_added",
    "correlation": {
        "conversationId": "response_77",
        "requestId": "f86d1d9515f6e8...",
        "incidentId": "inc_7w2k3m4q",
        "responseId": null
    }
}
```

## Breaker Events

Required events:

- `chat.orchestration.breaker_signal`: rule fired.
- `chat.orchestration.breaker_action_applied`: orchestration applied breaker outcome metadata.

Example `chat.orchestration.breaker_signal`:

```json
{
    "event": "chat.orchestration.breaker_signal",
    "mode": "observe_only",
    "action": "block",
    "ruleId": "safety.weaponization_request.v1",
    "reasonCode": "weaponization_request",
    "safetyTier": "High",
    "surface": "discord",
    "triggerKind": "direct",
    "correlation": {
        "conversationId": "session-77",
        "requestId": "discord-msg-77",
        "incidentId": null,
        "responseId": null
    }
}
```

Example `chat.orchestration.breaker_action_applied`:

```json
{
    "event": "chat.orchestration.breaker_action_applied",
    "mode": "observe_only",
    "action": "block",
    "ruleId": "safety.weaponization_request.v1",
    "reasonCode": "weaponization_request",
    "safetyTier": "High",
    "enforcement": "observe_only",
    "responseAction": "message",
    "responseModality": "text",
    "correlation": {
        "conversationId": "session-77",
        "requestId": "discord-msg-77",
        "incidentId": null,
        "responseId": "chat_test_response"
    }
}
```
