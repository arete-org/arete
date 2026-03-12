/**
 * @description: Runs the shared reflect workflow: prompt assembly, model call,
 * metadata generation, and background trace persistence.
 * @footnote-scope: core
 * @footnote-module: ReflectService
 * @footnote-risk: high - Mistakes here change the canonical reflect behavior used by multiple callers.
 * @footnote-ethics: high - This workflow owns the AI response and provenance metadata users rely on.
 */
import type {
    PartialResponseTemperament,
    ResponseMetadata,
    RiskTier,
} from '@footnote/contracts/ethics-core';
import type { PostReflectResponse } from '@footnote/contracts/web';
import type { ReflectConversationMessage } from '@footnote/contracts/web';
import type {
    GenerateResponseOptions,
    OpenAIService,
    OpenAIResponseMetadata,
    ResponseMetadataRuntimeContext,
} from './openaiService.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import { buildRepoExplainerResponseHint } from './reflectGenerationHints.js';
import type { ReflectGenerationPlan } from './reflectGenerationTypes.js';
import { renderPrompt } from './prompts/promptRegistry.js';
import { logger } from '../utils/logger.js';

const DEFAULT_BOT_PROFILE_DISPLAY_NAME = 'Footnote';

/**
 * Keeps backend-only reflect persona rendering aligned with deployment naming.
 */
const resolveBotProfileDisplayName = (): string => {
    const envValue = process.env.BOT_PROFILE_DISPLAY_NAME;
    if (typeof envValue === 'string' && envValue.trim().length > 0) {
        return envValue.trim();
    }

    return DEFAULT_BOT_PROFILE_DISPLAY_NAME;
};

/**
 * Dependencies for the shared reflect workflow.
 * The HTTP handler injects these so the core logic stays transport-agnostic.
 */
export type CreateReflectServiceOptions = {
    openaiService: OpenAIService;
    storeTrace: (metadata: ResponseMetadata) => Promise<void>;
    buildResponseMetadata: (
        assistantMetadata: OpenAIResponseMetadata,
        runtimeContext: ResponseMetadataRuntimeContext
    ) => ResponseMetadata;
    defaultModel: string;
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

/**
 * Minimal input required to run the canonical reflect flow.
 */
export type RunReflectInput = {
    question: string;
};

/**
 * Shared message-generation input used by the Discord/backend unified path.
 */
export type RunReflectMessagesInput = {
    messages: Array<Pick<ReflectConversationMessage, 'role' | 'content'>>;
    conversationSnapshot: string;
    plannerTemperament?: PartialResponseTemperament;
    riskTier?: RiskTier;
    model?: string;
    generation?: ReflectGenerationPlan;
};

/**
 * Builds the shared reflect workflow used by HTTP callers today and future
 * internal callers later. The output intentionally matches `PostReflectResponse`
 * so transports do not need to reshape it.
 */
export const createReflectService = ({
    openaiService,
    storeTrace,
    buildResponseMetadata,
    defaultModel,
    recordUsage = recordBackendLLMUsage,
}: CreateReflectServiceOptions) => {
    const runReflectMessages = async ({
        messages,
        conversationSnapshot,
        plannerTemperament,
        riskTier,
        model,
        generation,
    }: RunReflectMessagesInput): Promise<{
        message: string;
        metadata: ResponseMetadata;
    }> => {
        const repoExplainerHint = generation
            ? buildRepoExplainerResponseHint(generation)
            : null;
        const messagesWithHints = repoExplainerHint
            ? [
                  ...messages,
                  {
                      role: 'system',
                      content: repoExplainerHint,
                  },
              ]
            : messages;
        const generationOptions: GenerateResponseOptions = generation
            ? {
                  reasoningEffort: generation.reasoningEffort,
                  verbosity: generation.verbosity,
                  toolChoice: generation.toolChoice,
                  webSearch: generation.webSearch,
              }
            : {};

        // The OpenAI wrapper already handles provider-specific request/retry details.
        const aiResponse = await openaiService.generateResponse(
            model ?? defaultModel,
            messagesWithHints,
            generationOptions
        );

        const { normalizedText, metadata: assistantMetadata } = aiResponse;
        const usageModel = assistantMetadata.model || defaultModel;
        const promptTokens = assistantMetadata.usage?.prompt_tokens ?? 0;
        const completionTokens =
            assistantMetadata.usage?.completion_tokens ?? 0;
        const totalTokens =
            assistantMetadata.usage?.total_tokens ??
            promptTokens + completionTokens;
        const estimatedCost = estimateBackendTextCost(
            usageModel,
            promptTokens,
            completionTokens
        );
        if (recordUsage) {
            try {
                recordUsage({
                    feature: 'reflect',
                    model: usageModel,
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    ...estimatedCost,
                    timestamp: Date.now(),
                });
            } catch (error) {
                logger.warn(
                    `Reflect usage recording failed: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        const runtimeContext: ResponseMetadataRuntimeContext = {
            modelVersion: usageModel,
            conversationSnapshot: `${conversationSnapshot}\n\n${normalizedText}`,
            plannerTemperament,
            usedWebSearch: generation?.toolChoice === 'web_search',
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
        const normalizedResponseMetadata: ResponseMetadata = shouldRaiseRiskTier
            ? {
                  ...responseMetadata,
                  riskTier,
              }
            : responseMetadata;

        // These logs are intentionally verbose because metadata mismatches are hard to debug later.
        logger.debug('=== Server Metadata Debug ===');
        logger.debug(
            `Assistant metadata: ${JSON.stringify(assistantMetadata, null, 2)}`
        );
        logger.debug(
            `Built response metadata: ${JSON.stringify(normalizedResponseMetadata, null, 2)}`
        );
        logger.debug('================================');

        // Trace writes stay fire-and-forget so a storage hiccup does not block the user response.
        storeTrace(normalizedResponseMetadata).catch((error) => {
            logger.error(
                `Background trace storage error: ${error instanceof Error ? error.message : String(error)}`
            );
        });

        return {
            message: normalizedText,
            metadata: normalizedResponseMetadata,
        };
    };

    const runReflect = async ({
        question,
    }: RunReflectInput): Promise<PostReflectResponse> => {
        const botProfileDisplayName = resolveBotProfileDisplayName();
        // Keep prompt assembly here so the public web reflect path stays stable.
        const messages: Array<
            Pick<ReflectConversationMessage, 'role' | 'content'>
        > = [
            {
                role: 'system',
                content: renderPrompt('reflect.chat.system').content,
            },
            {
                role: 'system',
                content: renderPrompt('reflect.chat.persona.footnote', {
                    botProfileDisplayName,
                }).content,
            },
            { role: 'user', content: question.trim() },
        ];
        const response = await runReflectMessages({
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
        runReflect,
        runReflectMessages,
    };
};
