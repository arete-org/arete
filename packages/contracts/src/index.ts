/**
 * @description: Re-exports the shared contract types used by backend, Discord, and web.
 * @footnote-scope: interface
 * @footnote-module: ContractsIndex
 * @footnote-risk: low - Incorrect exports can cause type drift between packages.
 * @footnote-ethics: medium - Types document data meaning but do not execute logic.
 */

// This file stays small on purpose. Packages can import shared types from one
// place without needing to know the internal folder layout of the contracts
// package.

// Ethics Core contracts (provenance/risk metadata)
export type {
    Provenance,
    RiskTier,
    RiskRuleId,
    RiskEvaluationResult,
    Citation,
    ExecutionStatus,
    ExecutionReasonCode,
    ExecutionEvent,
    TraceAxisScore,
    PartialResponseTemperament,
    ResponseTemperament,
    ResponseMetadata,
} from './ethics-core/index.js';
export { formatExecutionTimelineSummary } from './ethics-core/index.js';

// Web API contracts (request/response envelopes)
export type {
    ApiErrorResponse,
    NormalizedApiError,
    ChatSurface,
    ChatTriggerKind,
    ChatProfileOption,
    ChatConversationMessage,
    ChatAttachment,
    ChatCapabilities,
    ChatImageRequest,
    PostChatRequest,
    ChatMessageActionResponse,
    ChatReactActionResponse,
    ChatIgnoreActionResponse,
    ChatImageActionResponse,
    PostChatResponse,
    GetChatProfilesResponse,
    InternalImageAnnotations,
    InternalImageBackground,
    InternalImageChannelContext,
    InternalImageErrorEvent,
    InternalImageGenerationArtifact,
    InternalImagePartialImageEvent,
    InternalImageQuality,
    InternalImageRenderModel,
    InternalImageResultEvent,
    InternalImageSize,
    InternalImageStreamEvent,
    InternalImageTextModel,
    InternalImageUserContext,
    PostInternalImageGenerateRequest,
    PostInternalImageGenerateResponse,
    PostInternalImageRequest,
    PostInternalImageResponse,
    PostInternalImageDescriptionTaskRequest,
    PostInternalImageDescriptionTaskResponse,
    PostTracesRequest,
    PostTracesResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    GetRuntimeConfigResponse,
    BlogAuthor,
    BlogPostMetadata,
    BlogPost,
    ListBlogPostsResponse,
    GetBlogPostResponse,
} from './web/index.js';

// Internal voice contracts (tts + realtime)
export type {
    InternalTtsCosts,
    InternalTtsModel,
    InternalTtsOptions,
    InternalTtsUsage,
    InternalTtsVoice,
    InternalVoiceChannelContext,
    InternalVoiceOutputFormat,
    InternalVoiceParticipant,
    InternalVoiceRealtimeClientEvent,
    InternalVoiceRealtimeOptions,
    InternalVoiceRealtimeServerEvent,
    InternalVoiceSessionContext,
    PostInternalVoiceTtsRequest,
    PostInternalVoiceTtsResponse,
} from './voice/index.js';

// Shared AI/provider vocabulary
export type {
    ConfiguredProviderModel,
    InternalImageRenderModelId,
    InternalImageTextModelId,
    InternalTtsModelId,
    InternalTtsVoiceId,
    SupportedBotInteractionAction,
    SupportedEngagementIgnoreMode,
    SupportedImageOutputFormat,
    SupportedLogLevel,
    SupportedOpenAIImageModel,
    SupportedOpenAIRealtimeModel,
    SupportedOpenAITextModel,
    SupportedOpenAITtsModel,
    SupportedOpenAITtsVoice,
    SupportedProvider,
    SupportedProviderModel,
    SupportedReasoningEffort,
    SupportedVerbosity,
} from './providers.js';
export type {
    ModelCostClass,
    ModelLatencyClass,
    ModelProfile,
    ModelProfileCapabilities,
    ModelTierAlias,
} from './model-profiles.js';
export {
    ModelProfileCapabilitiesSchema,
    ModelProfileCatalogSchema,
    ModelProfileSchema,
    modelCostClasses,
    modelLatencyClasses,
    modelTierAliases,
} from './model-profiles.js';

// Shared pricing vocabulary and pure cost helpers
export type {
    EffectiveImageGenerationQuality,
    EffectiveImageGenerationSize,
    ExplicitlyUnpricedOpenAITextModel,
    GPT5ModelType,
    ImageGenerationCostEstimate,
    ImageGenerationCostOptions,
    ImageGenerationQuality,
    ImageGenerationSize,
    ImageModelPricingKey,
    OmniModelType,
    ModelPricingCoverageClassification,
    ModelProfileTextPricingCoverage,
    OpenAIModelCanonicalizationResult,
    OpenAIModelCanonicalizationRule,
    OpenAITextCostBreakdown,
    OpenAITtsCostBreakdown,
    OpenAIModelPricingResolution,
    OpenAITextPricingEntry,
    PricedOpenAITextModel,
    SupportedOpenAIEmbeddingModel,
    TextModelPricingKey,
} from './pricing.js';
export {
    canonicalizeOpenAIModelIdForPricing,
    classifyModelProfileTextPricingCoverage,
    estimateOpenAIImageGenerationCost,
    estimateOpenAIRealtimeCost,
    estimateOpenAITextCost,
    estimateOpenAITtsCost,
    hasOpenAIImagePricing,
    hasOpenAIRealtimePricing,
    hasOpenAITextPricing,
    hasOpenAITtsPricing,
    openAIImageGenerationPricingTable,
    openAIRealtimePricingTable,
    openAITextPricingTable,
    openAITtsPricingTable,
    explicitlyUnpricedOpenAITextModels,
    resolveOpenAIImagePricingModel,
    resolveOpenAIRealtimePricingModel,
    resolveOpenAITextPricingModel,
    resolveOpenAITtsPricingModel,
    resolveEffectiveImageGenerationQuality,
    resolveEffectiveImageGenerationSize,
    supportedOpenAIEmbeddingModels,
    supportedPricedOpenAITextModels,
} from './pricing.js';
