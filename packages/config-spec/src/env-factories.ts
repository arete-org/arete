/**
 * @description: Small helpers for declaring environment defaults in a readable way.
 * @footnote-scope: utility
 * @footnote-module: EnvFactories
 * @footnote-risk: medium - Mistakes here can affect every derived env-spec export.
 * @footnote-ethics: medium - These helpers shape how defaults and safety-relevant config are documented.
 */

import type { EnvLiteralValue, EnvSpecEntry } from './types.js';

// Use this when the env variable has a straightforward, fixed fallback.
// Example: PORT -> literal(3000)
/**
 * Marks an env entry as having a direct, literal default value.
 */
export const literal = <T extends EnvLiteralValue>(value: T) =>
    ({ kind: 'literal', value }) as const;

// Use this when the "default" is really computed from some other condition.
// Example: WEB_BASE_URL -> derived(
//   'Uses https://<FLY_APP_NAME>.fly.dev when FLY_APP_NAME is set.',
//   'http://localhost:8080'
// )
/**
 * Marks an env default as derived so docs can explain the rule instead of
 * pretending there is one fixed value.
 */
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
/**
 * Marks an env entry as intentionally having no declared default.
 */
export const noDefault = () => ({ kind: 'none' }) as const;

// Use this when the effective fallback happens deeper in runtime logic and does
// not make sense as a simple literal or derived value here.
// Example: a URL or cache key assembled from several runtime inputs
/**
 * Marks an env default as runtime-derived when only the consuming package can
 * explain the final value.
 */
export const runtime = (description: string) =>
    ({ kind: 'runtime', description }) as const;

// This thin wrapper keeps each env entry fully typed while staying easy to
// scan in the main env-spec file.
// Example: defineEnv({ key: 'PORT', ..., defaultValue: literal(3000) })
/**
 * Preserves full typing for each env entry while keeping the main spec list
 * readable.
 */
export const defineEnv = <const TEntry extends EnvSpecEntry>(entry: TEntry) =>
    entry;
