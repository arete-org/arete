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
    Citation,
    TraceAxisScore,
    PartialResponseTemperament,
    ResponseTemperament,
    ResponseMetadata,
} from './ethics-core/index.js';

// Web API contracts (request/response envelopes)
export type {
    ApiErrorResponse,
    NormalizedApiError,
    ReflectSurface,
    ReflectTriggerKind,
    ReflectConversationMessage,
    ReflectAttachment,
    ReflectCapabilities,
    ReflectImageRequest,
    PostReflectRequest,
    ReflectMessageActionResponse,
    ReflectReactActionResponse,
    ReflectIgnoreActionResponse,
    ReflectImageActionResponse,
    PostReflectResponse,
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

// Shared AI/provider vocabulary
export type {
    ConfiguredProviderModel,
    InternalImageRenderModelId,
    InternalImageTextModelId,
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
} from './providers.js';

// Shared pricing vocabulary and pure cost helpers
export type {
    EffectiveImageGenerationQuality,
    EffectiveImageGenerationSize,
    GPT5ModelType,
    ImageGenerationCostEstimate,
    ImageGenerationCostOptions,
    ImageGenerationQuality,
    ImageGenerationSize,
    ImageModelPricingKey,
    OmniModelType,
    OpenAITextCostBreakdown,
    OpenAITextPricingEntry,
    PricedOpenAITextModel,
    SupportedOpenAIEmbeddingModel,
    TextModelPricingKey,
} from './pricing.js';
export {
    estimateOpenAIImageGenerationCost,
    estimateOpenAITextCost,
    hasOpenAIImagePricing,
    hasOpenAITextPricing,
    openAIImageGenerationPricingTable,
    openAITextPricingTable,
    resolveEffectiveImageGenerationQuality,
    resolveEffectiveImageGenerationSize,
    supportedOpenAIEmbeddingModels,
    supportedPricedOpenAITextModels,
} from './pricing.js';
