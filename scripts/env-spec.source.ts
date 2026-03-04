/**
 * @description: Repo-level entry point for the shared environment spec and canonical defaults.
 * @footnote-scope: interface
 * @footnote-module: RootEnvSpec
 * @footnote-risk: medium - Drift here would misdocument package defaults across the repo.
 * @footnote-ethics: medium - Central env metadata influences safety-related defaults and operator understanding.
 */

// App packages should not import from scripts/. That would make isolated
// package builds fragile. The real shared copy lives in config-spec, and this
// file exists as the repo-level entrypoint for docs and tooling.

// --- Runtime exports ---
export {
    defineEnv,
    defineEnvMap,
    derived,
    envDefaultValues,
    envEntries,
    envSpec,
    envSpecByKey,
    literal,
    noDefault,
    runtime,
    runtimeFallbacks,
} from '../packages/config-spec/src/index.js';
export {
    supportedOpenAIImageModels,
    supportedOpenAITextModels,
    supportedProviders,
} from '../packages/contracts/src/providers.js';

// --- Type exports ---
export type {
    EnvDefault,
    EnvLiteralValue,
    EnvOwner,
    EnvSpecEntry,
    EnvStage,
    EnvValueKind,
} from '../packages/config-spec/src/index.js';

export type {
    ConfiguredProviderModel,
    SupportedBotInteractionAction,
    SupportedEngagementIgnoreMode,
    SupportedImageOutputFormat,
    SupportedLogLevel,
    SupportedOpenAIImageModel,
    SupportedOpenAITextModel,
    SupportedProvider,
    SupportedProviderModel,
    SupportedReasoningEffort,
    SupportedVerbosity,
} from '../packages/contracts/src/providers.js';
