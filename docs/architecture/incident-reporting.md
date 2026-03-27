# Incident Reporting

## Purpose

Define the user-facing incident reporting flow, and its behavior and boundaries, for assistant messages on Discord.

## Scope

This flow covers:

- a user choosing to report one assistant response,
- explicit consent before any durable record is created,
- optional user-supplied context,
- automatic capture of stable pointers,
- immediate confirmation back to the reporter,
- optional follow-on remediation of the reported assistant message.

## User Flow

1. A user clicks the `Report Issue` provenance control on an assistant response.
2. The bot presents a private consent step.
3. If the user declines, the flow stops and no incident is created.
4. If the user consents, the bot may collect optional inputs:
    - tags,
    - short description,
    - contact preference.
5. The bot creates one durable incident record with captured pointers.
6. The bot confirms that the report was recorded.
7. If the configured policy requires immediate remediation, the bot marks the reported assistant message as under review.

## Required Captured Context

The reporting flow must capture pointers rather than broad content copies wherever possible.

Required pointers:

- assistant message ID,
- channel ID,
- guild ID when present,
- message jump URL when available,
- response ID when available,
- provenance metadata pointers such as `chainHash` and `modelVersion` when available.

Optional user-provided context:

- tags,
- short free-text description,
- contact handle or reply preference.

## Consent Rules

The system must not create an incident record until the user explicitly consents.

Consent must be:

- specific to the selected assistant message,
- private to the reporting user,
- recorded as part of the incident creation audit trail.

Canceling the flow must leave no durable incident row behind.

## Remediation Boundary

Reporting and remediation are related but separate concerns.

The reporting flow is allowed to trigger immediate remediation only when:

- the target message is confirmed to be an assistant-authored message,
- the remediation helper is idempotent,
- the incident record can reflect whether remediation was applied.

## Invariants

- No durable incident record is created without explicit user consent.
- Reporting captures stable pointers first and minimizes retained free text.
- The system never persists raw Discord identifiers in incident storage.
- Reporting one message creates at most one incident per completed submission action.
- User-facing failures do not block normal message processing outside the report flow.
