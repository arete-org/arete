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

export type SupportedReasoningEffort = 'low' | 'medium' | 'high';
export type SupportedVerbosity = 'low' | 'medium' | 'high';
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
export type SupportedBotInteractionAction = 'ignore' | 'react';
export type SupportedEngagementIgnoreMode = 'silent' | 'react';
export type SupportedImageOutputFormat = 'png' | 'webp' | 'jpeg';
