/**
 * @description: Runs the shared reflect workflow: prompt assembly, model call,
 * metadata generation, and background trace persistence.
 * @footnote-scope: core
 * @footnote-module: ReflectService
 * @footnote-risk: high - Mistakes here change the canonical reflect behavior used by multiple callers.
 * @footnote-ethics: high - This workflow owns the AI response and provenance metadata users rely on.
 */
import type {
    ResponseMetadata,
    RiskTier,
} from '@footnote/contracts/ethics-core';
import type { PostReflectResponse } from '@footnote/contracts/web';
import type {
    OpenAIService,
    OpenAIResponseMetadata,
    ResponseMetadataRuntimeContext,
} from './openaiService.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import { logger } from '../utils/logger.js';

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
    messages: Array<{ role: string; content: string }>;
    conversationSnapshot: string;
    riskTier?: RiskTier;
    model?: string;
};

// The reflect prompt stays in backend so every caller gets the same behavior and metadata rules.
const REFLECT_SYSTEM_PROMPT = `You are Ari, an AI assistant from the Footnote project. You help people think through tough questions while staying honest and fair. You explore multiple ethical perspectives, trace your sources, and show how you reach your conclusions. Be helpful, thoughtful, and transparent in your responses.

RESPONSE METADATA PAYLOAD
After your conversational reply, leave a blank line and append a single JSON object on its own line prefixed with <RESPONSE_METADATA>.
This metadata records provenance and confidence for downstream systems.

Required fields:
  - provenance: one of "Retrieved", "Inferred", or "Speculative"
  - confidence: floating-point certainty between 0.0 and 1.0 (e.g., 0.85)
  - tradeoffCount: integer >= 0 capturing how many value tradeoffs you surfaced (use 0 if none)
  - citations: array of {"title": string, "url": fully-qualified URL, "snippet"?: string} objects (use [] if none)

Example:
<RESPONSE_METADATA>{"provenance":"Retrieved","confidence":0.78,"tradeoffCount":1,"citations":[{"title":"Example","url":"https://example.com"}]}

Guidelines:
  - Emit valid, minified JSON (no comments, no code fences, no trailing text)
  - Always include the <RESPONSE_METADATA> block after every response
  - Use "Inferred" for reasoning-based answers, "Retrieved" for fact-based, "Speculative" for uncertain answers`;

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
        riskTier = 'Low',
        model,
    }: RunReflectMessagesInput): Promise<{
        message: string;
        metadata: ResponseMetadata;
    }> => {
        // The OpenAI wrapper already handles provider-specific request/retry details.
        const aiResponse = await openaiService.generateResponse(
            model ?? defaultModel,
            messages
        );

        const { normalizedText, metadata: assistantMetadata } = aiResponse;
        const usageModel = assistantMetadata.model || defaultModel;
        const promptTokens = assistantMetadata.usage?.prompt_tokens ?? 0;
        const completionTokens = assistantMetadata.usage?.completion_tokens ?? 0;
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
        };

        // Metadata is the contract that downstream UIs and trace storage rely on.
        const responseMetadata = buildResponseMetadata(
            assistantMetadata,
            runtimeContext
        );
        const normalizedResponseMetadata: ResponseMetadata =
            responseMetadata.riskTier === riskTier
                ? responseMetadata
                : {
                      ...responseMetadata,
                      riskTier,
                  };

        // These logs are intentionally verbose because metadata mismatches are hard to debug later.
        logger.debug('=== Server Metadata Debug ===');
        logger.debug(
            `Assistant metadata: ${JSON.stringify(assistantMetadata, null, 2)}`
        );
        logger.debug(
            `Assistant metadata confidence: ${(assistantMetadata as { confidence?: number })?.confidence}`
        );
        logger.debug(
            `Built response metadata: ${JSON.stringify(normalizedResponseMetadata, null, 2)}`
        );
        logger.debug(
            `Response metadata confidence: ${(normalizedResponseMetadata as { confidence?: number }).confidence}`
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
        // Keep prompt assembly here so the public web reflect path stays stable.
        const messages = [
            { role: 'system', content: REFLECT_SYSTEM_PROMPT },
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
