/**
 * @description: Lists the provider, model, and shared option values that multiple Footnote packages agree on.
 * @footnote-scope: interface
 * @footnote-module: SupportedProviders
 * @footnote-risk: low - A wrong value here can make one package accept input that another package rejects.
 * @footnote-ethics: medium - Shared model names and defaults shape routing, cost tracking, and transparency language.
 */

/**
 * Provider backends currently recognized by shared Footnote packages.
 */
export const supportedProviders = ['openai'] as const;

/**
 * One known provider identifier.
 */
export type SupportedProvider = (typeof supportedProviders)[number];

/**
 * Node environment values the repo treats as valid runtime modes.
 */
export const supportedNodeEnvs = ['production', 'development', 'test'] as const;

/**
 * One supported Node runtime mode.
 */
export type SupportedNodeEnv = (typeof supportedNodeEnvs)[number];

/**
 * OpenAI text models Footnote knows how to validate, display, and price today.
 * This list is the shared source of truth for trusted image-task contracts and
 * other curated model pickers.
 */
export const supportedOpenAITextModels = [
    'gpt-5.2',
    'gpt-5.1',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
] as const;

/**
 * One known OpenAI text model identifier.
 */
export type SupportedOpenAITextModel =
    (typeof supportedOpenAITextModels)[number];

/**
 * OpenAI image models Footnote knows how to validate, display, and price
 * today.
 */
export const supportedOpenAIImageModels = [
    'gpt-image-1.5',
    'gpt-image-1',
    'gpt-image-1-mini',
] as const;

/**
 * One known OpenAI image model identifier.
 */
export type SupportedOpenAIImageModel =
    (typeof supportedOpenAIImageModels)[number];

/**
 * OpenAI TTS models Footnote knows how to validate and price today.
 */
export const supportedOpenAITtsModels = [
    'tts-1',
    'tts-1-hd',
    'gpt-4o-mini-tts',
] as const;

/**
 * One known OpenAI TTS model identifier.
 */
export type SupportedOpenAITtsModel =
    (typeof supportedOpenAITtsModels)[number];

/**
 * OpenAI TTS voices Footnote knows how to validate today.
 */
export const supportedOpenAITtsVoices = [
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer',
] as const;

/**
 * One known OpenAI TTS voice identifier.
 */
export type SupportedOpenAITtsVoice =
    (typeof supportedOpenAITtsVoices)[number];

/**
 * OpenAI realtime models Footnote knows how to validate today.
 */
export const supportedOpenAIRealtimeModels = [
    'gpt-realtime',
    'gpt-realtime-mini',
] as const;

/**
 * One known OpenAI realtime model identifier.
 */
export type SupportedOpenAIRealtimeModel =
    (typeof supportedOpenAIRealtimeModels)[number];

/**
 * OpenAI realtime turn detection modes supported by the bot runtime.
 */
export const supportedOpenAIRealtimeTurnDetections = [
    'server_vad',
    'semantic_vad',
] as const;

/**
 * One supported OpenAI realtime turn detection mode.
 */
export type SupportedOpenAIRealtimeTurnDetection =
    (typeof supportedOpenAIRealtimeTurnDetections)[number];

/**
 * OpenAI realtime semantic VAD eagerness values supported by shared config.
 */
export const supportedOpenAIRealtimeVadEagerness = [
    'low',
    'medium',
    'high',
    'auto',
] as const;

/**
 * One supported semantic VAD eagerness value.
 */
export type SupportedOpenAIRealtimeVadEagerness =
    (typeof supportedOpenAIRealtimeVadEagerness)[number];

// Legacy alias retained for any downstream imports during refactors.
export type SupportedOpenAIRealtimeVadeagerness =
    SupportedOpenAIRealtimeVadEagerness;

/**
 * Curated text models accepted by the trusted internal image route.
 * This currently matches the shared OpenAI text registry exactly.
 */
export const internalImageTextModels = supportedOpenAITextModels;

/**
 * One text-model identifier accepted by the trusted internal image route.
 */
export type InternalImageTextModelId = (typeof internalImageTextModels)[number];

/**
 * Curated image models accepted by the trusted internal image route.
 * This currently matches the shared OpenAI image registry exactly.
 */
export const internalImageRenderModels = supportedOpenAIImageModels;

/**
 * One image-model identifier accepted by the trusted internal image route.
 */
export type InternalImageRenderModelId =
    (typeof internalImageRenderModels)[number];

/**
 * Curated TTS models accepted by the trusted internal voice route.
 */
export const internalTtsModels = supportedOpenAITtsModels;

/**
 * One TTS model identifier accepted by the trusted internal voice route.
 */
export type InternalTtsModelId = (typeof internalTtsModels)[number];

/**
 * Curated TTS voices accepted by the trusted internal voice route.
 */
export const internalTtsVoices = supportedOpenAITtsVoices;

/**
 * One TTS voice identifier accepted by the trusted internal voice route.
 */
export type InternalTtsVoiceId = (typeof internalTtsVoices)[number];

// "Supported" means Footnote knows about the model. "Configured" stays a bit
// wider so operators can try newer provider model strings before the codebase
// is updated.
/**
 * Any model identifier the codebase knows how to reason about today.
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
 * One supported reasoning effort value.
 */
export type SupportedReasoningEffort =
    (typeof supportedReasoningEfforts)[number];

/**
 * Verbosity levels shared across provider-backed text generation.
 */
export const supportedVerbosityLevels = ['low', 'medium', 'high'] as const;

/**
 * One supported verbosity value.
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
 * One supported log level.
 */
export type SupportedLogLevel = (typeof supportedLogLevels)[number];

/**
 * Actions the bot can take when it detects back-and-forth bot chatter.
 */
export const supportedBotInteractionActions = ['ignore', 'react'] as const;

/**
 * One supported bot-interaction response.
 */
export type SupportedBotInteractionAction =
    (typeof supportedBotInteractionActions)[number];

/**
 * Strategies for how the engagement filter declines to respond.
 */
export const supportedEngagementIgnoreModes = ['silent', 'react'] as const;

/**
 * One supported engagement ignore mode.
 */
export type SupportedEngagementIgnoreMode =
    (typeof supportedEngagementIgnoreModes)[number];

/**
 * Image output formats accepted by the shared image workflow.
 */
export const supportedImageOutputFormats = ['png', 'webp', 'jpeg'] as const;

/**
 * One supported image output format identifier.
 */
export type SupportedImageOutputFormat =
    (typeof supportedImageOutputFormats)[number];
