# Footnote Annotations

This document defines the required header annotations for Footnote modules and the allowed values.
The canonical schema lives in `scripts/annotation-schema.source.ts`, and the checked-in
runtime copy is `scripts/annotation-schema.runtime.json`.

## Required Header Format

Order is fixed:

1. `@description` (colon required)
2. `@footnote-scope` (colon required)
3. `@footnote-module` (colon required)
4. `@footnote-risk: <low|medium|high> - ...`
5. `@footnote-ethics: <low|medium|high> - ...`

Example:

```ts
/**
 * @description: Handles realtime audio streaming and event dispatch for the bot.
 * @footnote-scope: core
 * @footnote-module: RealtimeEventHandler
 * @footnote-risk: high - Event handling failures can break live audio or message delivery.
 * @footnote-ethics: high - Realtime audio flow affects privacy and consent expectations.
 */
```

## Allowed Values

- `@footnote-scope`: `core`, `utility`, `interface`, `web`, `test`
- `@footnote-risk`: `low`, `medium`, `high`
- `@footnote-ethics`: `low`, `medium`, `high`

## Tag Meaning

- `@footnote-risk`: Technical blast radius if the module fails, is misconfigured, or is misused.
- `@footnote-ethics`: User-facing or governance harm if the module behaves incorrectly.

## Level Rubric

### `low`

- `@footnote-risk`: Small, localized breakage such as layout issues, logging gaps, or isolated helper failures.
- `@footnote-ethics`: Minimal direct user harm, such as purely structural or internal developer-facing code.

### `medium`

- `@footnote-risk`: Breakage that can disrupt a feature, hide key metadata, or misroute traffic without taking down the full system.
- `@footnote-ethics`: Mistakes that can mislead users, weaken transparency cues, or degrade consent/privacy expectations in one surface.

### `high`

- `@footnote-risk`: Failures that can break core user flows, corrupt provenance, leak data, or destabilize major subsystems.
- `@footnote-ethics`: Mistakes that can materially affect privacy, consent, fairness, accountability, or trust in the system.

## Module Names

- `@footnote-module` is currently freeform but must be stable and descriptive.
- Use PascalCase, avoid abbreviations, and keep names unique within the repo.
- If you want a hard allowlist, add it here and extend the schema/validator tooling in `scripts/`.

