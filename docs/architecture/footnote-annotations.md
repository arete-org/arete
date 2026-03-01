# Footnote Annotations

This document defines the required header annotations for Footnote modules and the allowed values.

## Required Header Format

Order is fixed:

1. `@description` (colon required)
2. `@footnote-scope` (colon required)
3. `@footnote-module` (colon required)
4. `@footnote-risk: <low|moderate|high> - ...`
5. `@footnote-ethics: <low|moderate|high> - ...`

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

- `@footnote-scope`: `core`, `utility`, `interface`, `test`
- `@footnote-risk`: `low`, `moderate`, `high`
- `@footnote-ethics`: `low`, `moderate`, `high`

## Module Names

- `@footnote-module` is currently freeform but must be stable and descriptive.
- Use PascalCase, avoid abbreviations, and keep names unique within the repo.
- If you want a hard allowlist, add it here and extend `scripts/validate-footnote-tags.js`.

