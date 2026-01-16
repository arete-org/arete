# ARETE Annotations

This document defines the required header annotations for ARETE modules and the allowed values.

## Required Header Format

Order is fixed:

1. `@description` (colon required)
2. `@arete-scope` (colon required)
3. `@arete-module` (colon required)
4. `@arete-risk: <low|moderate|high> - ...`
5. `@arete-ethics: <low|moderate|high> - ...`

Example:

```ts
/**
 * @description: Handles realtime audio streaming and event dispatch for the bot.
 * @arete-scope: core
 * @arete-module: RealtimeEventHandler
 * @arete-risk: high - Event handling failures can break live audio or message delivery.
 * @arete-ethics: high - Realtime audio flow affects privacy and consent expectations.
 */
```

## Allowed Values

- `@arete-scope`: `core`, `utility`, `interface`, `test`
- `@arete-risk`: `low`, `moderate`, `high`
- `@arete-ethics`: `low`, `moderate`, `high`

## Module Names

- `@arete-module` is currently freeform but must be stable and descriptive.
- Use PascalCase, avoid abbreviations, and keep names unique within the repo.
- If you want a hard allowlist, add it here and extend `scripts/validate-arete-tags.js`.
