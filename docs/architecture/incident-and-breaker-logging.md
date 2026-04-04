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

## Alert Routing Configuration

Incident and breaker events can fan out to Discord and/or admin email targets.
Each target is independently configurable and can be disabled without affecting
the primary request flow.

### Discord Alert Target

- `INCIDENT_ALERTS_DISCORD_ENABLED` (default: `false`)
- `INCIDENT_ALERTS_DISCORD_BOT_TOKEN` (required when enabled)
- `INCIDENT_ALERTS_DISCORD_CHANNEL_ID` (required when enabled)
- `INCIDENT_ALERTS_DISCORD_ROLE_ID` (optional role mention)

### Email Alert Target (SMTP)

- `INCIDENT_ALERTS_EMAIL_ENABLED` (default: `false`)
- `INCIDENT_ALERTS_EMAIL_SMTP_HOST` (required when enabled)
- `INCIDENT_ALERTS_EMAIL_SMTP_PORT` (default: `587`)
- `INCIDENT_ALERTS_EMAIL_SMTP_SECURE` (default: `false`)
- `INCIDENT_ALERTS_EMAIL_SMTP_USERNAME` (optional, must be paired with password)
- `INCIDENT_ALERTS_EMAIL_SMTP_PASSWORD` (optional, must be paired with username)
- `INCIDENT_ALERTS_EMAIL_FROM` (required when enabled)
- `INCIDENT_ALERTS_EMAIL_TO` (required when enabled; comma-separated recipients)

### Fail-Open Delivery Contract

- Alert delivery runs as side-effect telemetry and never blocks incident writes
  or chat response generation.
- Delivery failures are logged as structured warning events with:
    - `event=incident.alert.delivery_failed`
    - `alertChannel` (`discord` or `email`)
    - `alertType` (`incident` or `breaker`)
    - `alertAction` (for example `incident.created`)
    - `error` (delivery error summary)
