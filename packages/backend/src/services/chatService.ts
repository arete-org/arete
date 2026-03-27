/**
 * @description: Runs the shared chat workflow: prompt assembly, model call,
 * metadata generation, and background trace persistence.
 * @footnote-scope: core
 * @footnote-module: ChatService
 * @footnote-risk: high - Mistakes here change the canonical chat behavior used by multiple callers.
 * @footnote-ethics: high - This workflow owns the AI response and provenance metadata users rely on.
 */
import type {
    GenerationResult,
    GenerationRuntime,
    GenerationRequest,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type {
    PartialResponseTemperament,
    ResponseMetadata,
    RiskTier,
} from '@footnote/contracts/ethics-core';
import type {
    ModelProfileCapabilities,
    SupportedProvider,
} from '@footnote/contracts';
import type { PostChatResponse } from '@footnote/contracts/web';
import type {
    AssistantResponseMetadata,
    AssistantUsage,
    ResponseMetadataRuntimeContext,
} from './openaiService.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import { buildRepoExplainerResponseHint } from './chatGenerationHints.js';
import type { ChatGenerationPlan } from './chatGenerationTypes.js';
import { renderConversationPromptLayers } from './prompts/conversationPromptLayers.js';
import { logger } from '../utils/logger.js';
import { runtimeConfig } from '../config.js';

/**
 * Search is optional, but if it is present it needs a real query. Blank values
 * should fail open to normal generation instead of forcing retrieval tooling.
 */
const normalizeGenerationPlan = (
    generation: ChatGenerationPlan | undefined
): ChatGenerationPlan | undefined => {
    if (!generation?.search) {
        return generation;
    }

    const normalizedQuery = generation.search.query.trim();
    if (normalizedQuery.length === 0) {
        logger.warn(
            'Chat generation requested search without a usable query; continuing without retrieval.'
        );

        return {
            ...generation,
            search: undefined,
        };
    }

    return {
        ...generation,
        search: {
            ...generation.search,
            query: normalizedQuery,
        },
    };
};

/**
 * Dependencies for the shared chat workflow.
 * The HTTP handler injects these so the core logic stays transport-agnostic.
 */
export type CreateChatServiceOptions = {
    generationRuntime: GenerationRuntime;
    storeTrace: (metadata: ResponseMetadata) => Promise<void>;
    buildResponseMetadata: (
        assistantMetadata: AssistantResponseMetadata,
        runtimeContext: ResponseMetadataRuntimeContext
    ) => ResponseMetadata;
    // Fallback model used when callers do not specify one and runtime output
    // does not report a concrete model id.
    defaultModel: string;
    // Optional provider/capability defaults from model profile resolution.
    defaultProvider?: SupportedProvider;
    defaultCapabilities?: ModelProfileCapabilities;
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

/**
 * Minimal input required to run the canonical chat flow.
 */
export type RunChatInput = {
    question: string;
};

/**
 * Shared message-generation input used by the Discord/backend unified path.
 */
export type RunChatMessagesInput = {
    messages: RuntimeMessage[];
    conversationSnapshot: string;
    orchestrationStartedAtMs?: number;
    plannerTemperament?: PartialResponseTemperament;
    riskTier?: RiskTier;
    model?: string;
    provider?: SupportedProvider;
    capabilities?: ModelProfileCapabilities;
    generation?: ChatGenerationPlan;
    executionContext?: ResponseMetadataRuntimeContext['executionContext'];
};

/**
 * Builds the shared chat workflow used by HTTP callers today and future
 * internal callers later. The output intentionally matches `PostChatResponse`
 * so transports do not need to reshape it.
 */
export const createChatService = ({
    generationRuntime,
    storeTrace,
    buildResponseMetadata,
    defaultModel,
    defaultProvider,
    defaultCapabilities,
    recordUsage = recordBackendLLMUsage,
}: CreateChatServiceOptions) => {
    /**
     * Normalizes one runtime result into the metadata shape backend already
     * uses for provenance, trace storage, and cost accounting.
     */
    const buildAssistantMetadata = (
        generationResult: GenerationResult,
        generation: ChatGenerationPlan | undefined,
        requestedModel: string | undefined
    ): AssistantResponseMetadata => {
        const usage: AssistantUsage | undefined = generationResult.usage
            ? {
                  promptTokens: generationResult.usage.promptTokens,
                  completionTokens: generationResult.usage.completionTokens,
                  totalTokens: generationResult.usage.totalTokens,
              }
            : undefined;

        return {
            // Prefer runtime-reported model first (actual execution target),
            // then request-level choice, then startup default.
            model: generationResult.model ?? requestedModel ?? defaultModel,
            usage,
            finishReason: generationResult.finishReason,
            reasoningEffort: generation?.reasoningEffort,
            verbosity: generation?.verbosity,
            provenance: generationResult.provenance,
            citations: generationResult.citations ?? [],
        };
    };

    const runChatMessages = async ({
        messages,
        conversationSnapshot,
        orchestrationStartedAtMs,
        plannerTemperament,
        riskTier,
        model,
        provider,
        capabilities,
        generation,
        executionContext,
    }: RunChatMessagesInput): Promise<{
        message: string;
        metadata: ResponseMetadata;
        generationDurationMs: number;
    }> => {
        const generationStartedAt = Date.now();
        const normalizedGeneration = normalizeGenerationPlan(generation);
        // Repo-explainer mode appends one helper system hint so responses stay
        // aligned with Footnote repository-explanation expectations.
        const repoExplainerHint = normalizedGeneration
            ? buildRepoExplainerResponseHint(normalizedGeneration)
            : null;
        const messagesWithHints: RuntimeMessage[] = repoExplainerHint
            ? [
                  ...messages,
                  {
                      role: 'system',
                      content: repoExplainerHint,
                  },
              ]
            : messages;
        const generationRequest: GenerationRequest = {
            messages: messagesWithHints,
            model: model ?? defaultModel,
            ...((provider ?? defaultProvider) !== undefined && {
                provider: provider ?? defaultProvider,
            }),
            ...((capabilities ?? defaultCapabilities) !== undefined && {
                capabilities: capabilities ?? defaultCapabilities,
            }),
            ...(normalizedGeneration?.reasoningEffort !== undefined && {
                reasoningEffort: normalizedGeneration.reasoningEffort,
            }),
            ...(normalizedGeneration?.verbosity !== undefined && {
                verbosity: normalizedGeneration.verbosity,
            }),
            ...(normalizedGeneration?.search !== undefined && {
                search: normalizedGeneration.search,
            }),
        };

        // One runtime call produces both user-visible text and metadata inputs.
        const generationResult =
            await generationRuntime.generate(generationRequest);
        // Generation duration is measured at the runtime boundary only.
        // It intentionally excludes planner time and pre/post processing.
        const generationDurationMs = Date.now() - generationStartedAt;
        const totalDurationMs =
            orchestrationStartedAtMs !== undefined
                ? Math.max(0, Date.now() - orchestrationStartedAtMs)
                : undefined;
        const assistantMetadata = buildAssistantMetadata(
            generationResult,
            normalizedGeneration,
            generationRequest.model
        );
        const retrievalUsed =
            generationResult.retrieval?.used === true ||
            generationResult.provenance === 'Retrieved' ||
            (generationResult.citations?.length ?? 0) > 0;
        const hasSearchIntent = normalizedGeneration?.search !== undefined;
        const effectiveToolExecutionContext:
            | NonNullable<
                  ResponseMetadataRuntimeContext['executionContext']
              >['tool']
            | undefined =
            // Respect an explicit upstream skip reason from orchestrator first.
            executionContext?.tool?.status === 'skipped'
                ? executionContext.tool
                : hasSearchIntent
                  ? {
                        // When search was requested, infer tool execution from
                        // retrieval usage signals reported by the runtime.
                        toolName: 'web_search',
                        status: retrievalUsed ? 'executed' : 'skipped',
                        ...(retrievalUsed
                            ? {}
                            : {
                                  reasonCode: 'tool_not_used',
                              }),
                    }
                  : undefined;

        const usageModel = assistantMetadata.model || defaultModel;
        const effectiveGenerationExecutionContext = executionContext?.generation
            ? {
                  ...executionContext.generation,
                  model: usageModel,
                  durationMs: generationDurationMs,
              }
            : undefined;
        const promptTokens = assistantMetadata.usage?.promptTokens ?? 0;
        const completionTokens = assistantMetadata.usage?.completionTokens ?? 0;
        const totalTokens =
            assistantMetadata.usage?.totalTokens ??
            promptTokens + completionTokens;
        const estimatedCost = estimateBackendTextCost(
            usageModel,
            promptTokens,
            completionTokens
        );
        if (recordUsage) {
            try {
                recordUsage({
                    feature: 'chat',
                    model: usageModel,
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    ...estimatedCost,
                    timestamp: Date.now(),
                });
            } catch (error) {
                // Cost telemetry should never block user responses.
                logger.warn(
                    `Chat usage recording failed: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        const runtimeContext: ResponseMetadataRuntimeContext = {
            modelVersion: usageModel,
            conversationSnapshot: `${conversationSnapshot}\n\n${generationResult.text}`,
            ...(totalDurationMs !== undefined && { totalDurationMs }),
            plannerTemperament,
            executionContext: {
                // Preserve upstream execution context and overlay runtime facts
                // (for example, generation duration + final resolved model).
                ...executionContext,
                ...(effectiveGenerationExecutionContext !== undefined && {
                    generation: effectiveGenerationExecutionContext,
                }),
                ...(effectiveToolExecutionContext !== undefined && {
                    tool: effectiveToolExecutionContext,
                }),
            },
            retrieval: {
                requested: hasSearchIntent,
                used: retrievalUsed,
                intent: normalizedGeneration?.search?.intent,
                contextSize: normalizedGeneration?.search?.contextSize,
            },
        };

        // Metadata is the contract that downstream UIs and trace storage rely on.
        const responseMetadata = buildResponseMetadata(
            assistantMetadata,
            runtimeContext
        );
        const riskTierRank: Record<RiskTier, number> = {
            Low: 1,
            Medium: 2,
            High: 3,
        };
        const shouldRaiseRiskTier =
            riskTier &&
            (!responseMetadata.riskTier ||
                riskTierRank[riskTier] >
                    riskTierRank[responseMetadata.riskTier]);
        // Planner may raise risk posture for this response, but we do not
        // downgrade a higher metadata risk tier that was already derived.
        const normalizedResponseMetadata: ResponseMetadata = shouldRaiseRiskTier
            ? {
                  ...responseMetadata,
                  riskTier,
              }
            : responseMetadata;

        // Trace writes stay fire-and-forget so a storage hiccup does not block the user response.
        storeTrace(normalizedResponseMetadata).catch((error) => {
            logger.error(
                `Background trace storage error: ${error instanceof Error ? error.message : String(error)}`
            );
        });

        return {
            message: generationResult.text,
            metadata: normalizedResponseMetadata,
            generationDurationMs,
        };
    };

    const runChat = async ({
        question,
    }: RunChatInput): Promise<PostChatResponse> => {
        const botProfileDisplayName = runtimeConfig.profile.displayName;
        const promptLayers = renderConversationPromptLayers('web-chat', {
            botProfileDisplayName,
        });
        // Keep prompt assembly here so the public web chat path stays stable.
        const messages: RuntimeMessage[] = [
            {
                role: 'system',
                content: promptLayers.systemPrompt,
            },
            {
                role: 'system',
                content: promptLayers.personaPrompt,
            },
            { role: 'user', content: question.trim() },
        ];
        const response = await runChatMessages({
            messages,
            conversationSnapshot: question.trim(),
        });

        return {
            action: 'message',
            message: response.message,
            modality: 'text',
            metadata: response.metadata,
        };
    };

    return {
        runChat,
        runChatMessages,
    };
};
