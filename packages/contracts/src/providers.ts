/**
 * @description: Shared provider and model vocabulary used across Footnote packages.
 * @footnote-scope: interface
 * @footnote-module: SupportedProviders
 * @footnote-risk: low - Wrong provider/model names cause type drift, not runtime behavior by themselves.
 * @footnote-ethics: medium - Provider/model naming shapes defaults, routing, and transparency language.
 */

export const supportedProviders = ['openai'] as const;
export type SupportedProvider = (typeof supportedProviders)[number];

export const supportedNodeEnvs = [
    'production',
    'development',
    'test',
] as const;
export type SupportedNodeEnv = (typeof supportedNodeEnvs)[number];

export const supportedOpenAITextModels = [
    'gpt-5',
    'gpt-5-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
] as const;
export type SupportedOpenAITextModel =
    (typeof supportedOpenAITextModels)[number];

export const supportedOpenAIImageModels = [
    'gpt-image-1-mini',
    'gpt-image-1',
    'gpt-image-1.5',
] as const;
export type SupportedOpenAIImageModel =
    (typeof supportedOpenAIImageModels)[number];

// "Supported" means Footnote knows about the model. "Configured" stays a bit
// wider so operators can try newer provider model strings before the codebase
// is updated.
export type SupportedProviderModel =
    | SupportedOpenAITextModel
    | SupportedOpenAIImageModel;
export type ConfiguredProviderModel = SupportedProviderModel | (string & {});

export const supportedReasoningEfforts = ['low', 'medium', 'high'] as const;
export type SupportedReasoningEffort =
    (typeof supportedReasoningEfforts)[number];

export const supportedVerbosityLevels = ['low', 'medium', 'high'] as const;
export type SupportedVerbosity = (typeof supportedVerbosityLevels)[number];

export const supportedLogLevels = [
    'error',
    'warn',
    'info',
    'http',
    'verbose',
    'debug',
    'silly',
] as const;
export type SupportedLogLevel = (typeof supportedLogLevels)[number];

export const supportedBotInteractionActions = ['ignore', 'react'] as const;
export type SupportedBotInteractionAction =
    (typeof supportedBotInteractionActions)[number];

export const supportedEngagementIgnoreModes = ['silent', 'react'] as const;
export type SupportedEngagementIgnoreMode =
    (typeof supportedEngagementIgnoreModes)[number];

export const supportedImageOutputFormats = ['png', 'webp', 'jpeg'] as const;
export type SupportedImageOutputFormat =
    (typeof supportedImageOutputFormats)[number];
