/**
 * @description: Public entry point for shared env metadata and canonical defaults.
 * @footnote-scope: interface
 * @footnote-module: ConfigSpecIndex
 * @footnote-risk: medium - Incorrect exports can create config drift across packages.
 * @footnote-ethics: medium - Central config metadata influences safety-related defaults and operator understanding.
 */

export {
    defineEnv,
    defineEnvMap,
    derived,
    literal,
    noDefault,
    runtime,
} from './env-factories.js';
export {
    envDefaultValues,
    envEntries,
    envSpec,
    envSpecByKey,
} from './env-spec.js';
export { runtimeFallbacks } from './runtime-fallbacks.js';
export type {
    EnvDefault,
    EnvLiteralValue,
    EnvOwner,
    EnvSpecEntry,
    EnvStage,
    EnvValueKind,
} from './types.js';
