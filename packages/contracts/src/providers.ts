/**
 * @description: Shared provider and model vocabulary used across Footnote packages.
 * @footnote-scope: interface
 * @footnote-module: SupportedProviders
 * @footnote-risk: low - Wrong provider/model names cause type drift, not runtime behavior by themselves.
 * @footnote-ethics: medium - Provider/model naming shapes defaults, routing, and transparency language.
 */

/**
 * Provider backends currently supported by shared Footnote packages.
 */
export const supportedProviders = ['openai'] as const;
/**
 * Union of currently supported provider identifiers.
 */
export type SupportedProvider = (typeof supportedProviders)[number];

/**
 * Node environment values the repo treats as valid runtime modes.
 */
export const supportedNodeEnvs = [
    'production',
    'development',
    'test',
] as const;
/**
 * Union of supported Node runtime modes.
 */
export type SupportedNodeEnv = (typeof supportedNodeEnvs)[number];

/**
 * OpenAI text-capable models explicitly recognized by shared config and cost
 * logic.
 */
export const supportedOpenAITextModels = [
    'gpt-5',
    'gpt-5-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
] as const;
/**
 * Union of the text model identifiers Footnote currently treats as known.
 */
export type SupportedOpenAITextModel =
    (typeof supportedOpenAITextModels)[number];

/**
 * OpenAI image-capable models explicitly recognized by shared config and image
 * tooling.
 */
export const supportedOpenAIImageModels = [
    'gpt-image-1-mini',
    'gpt-image-1',
    'gpt-image-1.5',
] as const;
/**
 * Union of the known image model identifiers.
 */
export type SupportedOpenAIImageModel =
    (typeof supportedOpenAIImageModels)[number];

// "Supported" means Footnote knows about the model. "Configured" stays a bit
// wider so operators can try newer provider model strings before the codebase
// is updated.
/**
 * Models the codebase knows how to reason about today.
 */
export type SupportedProviderModel =
    | SupportedOpenAITextModel
    | SupportedOpenAIImageModel;
/**
 * Model strings accepted from config, including forward-compatible custom
 * values.
 */
export type ConfiguredProviderModel = SupportedProviderModel | (string & {});

/**
 * Reasoning effort levels shared across planner and generation surfaces.
 */
export const supportedReasoningEfforts = ['low', 'medium', 'high'] as const;
/**
 * Union of supported reasoning effort settings.
 */
export type SupportedReasoningEffort =
    (typeof supportedReasoningEfforts)[number];

/**
 * Verbosity levels shared across provider-backed text generation.
 */
export const supportedVerbosityLevels = ['low', 'medium', 'high'] as const;
/**
 * Union of supported verbosity settings.
 */
export type SupportedVerbosity = (typeof supportedVerbosityLevels)[number];

/**
 * Log levels accepted by the shared logger config.
 */
export const supportedLogLevels = [
    'error',
    'warn',
    'info',
    'http',
    'verbose',
    'debug',
    'silly',
] as const;
/**
 * Union of supported log levels.
 */
export type SupportedLogLevel = (typeof supportedLogLevels)[number];

/**
 * Actions the bot can take when it detects back-and-forth bot chatter.
 */
export const supportedBotInteractionActions = ['ignore', 'react'] as const;
/**
 * Union of supported bot-interaction responses.
 */
export type SupportedBotInteractionAction =
    (typeof supportedBotInteractionActions)[number];

/**
 * Strategies for how the engagement filter declines to respond.
 */
export const supportedEngagementIgnoreModes = ['silent', 'react'] as const;
/**
 * Union of supported engagement ignore modes.
 */
export type SupportedEngagementIgnoreMode =
    (typeof supportedEngagementIgnoreModes)[number];

/**
 * Image output formats supported by the Discord image workflow.
 */
export const supportedImageOutputFormats = ['png', 'webp', 'jpeg'] as const;
/**
 * Union of supported image output format identifiers.
 */
export type SupportedImageOutputFormat =
    (typeof supportedImageOutputFormats)[number];
