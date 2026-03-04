/**
 * @description: Small helpers for declaring env metadata once and deriving multiple views from it.
 * @footnote-scope: utility
 * @footnote-module: EnvFactories
 * @footnote-risk: medium - Mistakes here can affect every derived env-spec export.
 * @footnote-ethics: medium - These helpers shape how defaults and safety-relevant config are documented.
 */

import type { EnvDefault, EnvLiteralValue, EnvSpecEntry } from './types.js';

// Use this when the env variable has a straightforward, fixed fallback.
// Example: PORT -> literal(3000)
export const literal = <T extends EnvLiteralValue>(value: T) =>
    ({ kind: 'literal', value }) as const;

// Use this when the "default" is really computed from some other condition.
// Example: WEB_BASE_URL -> derived(
//   'Uses https://<FLY_APP_NAME>.fly.dev when FLY_APP_NAME is set.',
//   'http://localhost:8080'
// )
export const derived = (
    description: string,
    fallbackValue?: string | number | boolean
) =>
    ({
        kind: 'derived',
        description,
        fallbackValue,
    }) as const;

// Use this when the spec intentionally does not declare any fallback value.
// Whether the app fails fast or handles absence later is decided by the
// package-level config parser, not by this helper itself.
// Example: DISCORD_TOKEN -> noDefault()
export const noDefault = () => ({ kind: 'none' }) as const;

// Use this when the effective fallback happens deeper in runtime logic and does
// not make sense as a simple literal or derived value here.
// Example: a URL or cache key assembled from several runtime inputs
export const runtime = (description: string) =>
    ({ kind: 'runtime', description }) as const;

// This helper keeps each env entry fully typed while staying easy to read in
// the main env-spec file. It is intentionally a thin identity wrapper.
// Example: defineEnv({ key: 'PORT', ..., defaultValue: literal(3000) })
export const defineEnv = <const TEntry extends EnvSpecEntry>(
    entry: TEntry
): TEntry => entry;

// Some call sites are easier to express as a keyed object before deriving other
// views. This preserves the exact entry types for that pattern too.
// Example: defineEnvMap({ PORT: defineEnv(...), HOST: defineEnv(...) })
export const defineEnvMap = <
    const TEntries extends Record<string, EnvSpecEntry<EnvDefault>>,
>(
    entries: TEntries
): TEntries => entries;
