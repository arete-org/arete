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
    SafetyTier,
    ToolExecutionContext,
    ToolInvocationRequest,
    WorkflowRecord,
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
import {
    WORKFLOW_NO_GENERATION_HANDLING_MAP,
    resolveNoGenerationHandlingFromTermination,
} from './workflowProfileContract.js';
import {
    runBoundedReviewWorkflow,
    type RunBoundedReviewWorkflowResult,
    type WorkflowPolicy,
} from './workflowEngine.js';
import { logger } from '../utils/logger.js';
import { runtimeConfig } from '../config.js';

const REVIEW_WORKFLOW_NAME = 'message_with_review_loop';
const SURFACED_NO_GENERATION_MESSAGE =
    'I could not generate a response for this request.';

const sanitizeNonNegativeInteger = (
    value: number,
    fallback: number
): number => {
    if (!Number.isFinite(value)) {
        return Math.max(0, Math.floor(fallback));
    }

    return Math.max(0, Math.floor(value));
};

const sanitizePositiveInteger = (value: number, fallback: number): number => {
    if (!Number.isFinite(value)) {
        return Math.max(1, Math.floor(fallback));
    }

    return Math.max(1, Math.floor(value));
};

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
    chatWorkflowConfig?: {
        reviewLoopEnabled: boolean;
        maxIterations: number;
        maxDurationMs: number;
    };
    runReviewWorkflow?: (
        input: Parameters<typeof runBoundedReviewWorkflow>[0]
    ) => Promise<RunBoundedReviewWorkflowResult>;
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
    safetyTier?: SafetyTier;
    model?: string;
    provider?: SupportedProvider;
    capabilities?: ModelProfileCapabilities;
    generation?: ChatGenerationPlan;
    executionContext?: ResponseMetadataRuntimeContext['executionContext'];
    toolRequest?: ToolInvocationRequest;
};

export type FinalToolExecutionTelemetry = {
    toolName: string;
    status: ToolExecutionContext['status'];
    reasonCode?: ToolExecutionContext['reasonCode'];
    eligible?: boolean;
    requestReasonCode?: ToolInvocationRequest['reasonCode'];
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
    chatWorkflowConfig = runtimeConfig.chatWorkflow,
    runReviewWorkflow = runBoundedReviewWorkflow,
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

    const recordUsageForStep = (
        result: GenerationResult,
        requestedModel: string | undefined
    ): {
        model: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedCost: ReturnType<typeof estimateBackendTextCost>;
    } => {
        const usageModel = result.model ?? requestedModel ?? defaultModel;
        const promptTokens = result.usage?.promptTokens ?? 0;
        const completionTokens = result.usage?.completionTokens ?? 0;
        const totalTokens =
            result.usage?.totalTokens ?? promptTokens + completionTokens;
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

        return {
            model: usageModel,
            promptTokens,
            completionTokens,
            totalTokens,
            estimatedCost,
        };
    };

    const runChatMessages = async ({
        messages,
        conversationSnapshot,
        orchestrationStartedAtMs,
        plannerTemperament,
        safetyTier,
        model,
        provider,
        capabilities,
        generation,
        executionContext,
        toolRequest,
    }: RunChatMessagesInput): Promise<{
        message: string;
        metadata: ResponseMetadata;
        generationDurationMs: number;
        finalToolExecutionTelemetry?: FinalToolExecutionTelemetry;
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
        const defaultWorkflowMaxIterations = sanitizeNonNegativeInteger(
            runtimeConfig.chatWorkflow.maxIterations,
            0
        );
        const defaultWorkflowMaxDurationMs = sanitizePositiveInteger(
            runtimeConfig.chatWorkflow.maxDurationMs,
            15000
        );
        const reviewLoopEnabled = chatWorkflowConfig.reviewLoopEnabled === true;
        const reviewLoopMaxIterations = sanitizeNonNegativeInteger(
            chatWorkflowConfig.maxIterations,
            defaultWorkflowMaxIterations
        );
        const reviewLoopMaxDurationMs = sanitizePositiveInteger(
            chatWorkflowConfig.maxDurationMs,
            defaultWorkflowMaxDurationMs
        );

        let generationResult: GenerationResult;
        let workflowLineage: WorkflowRecord | undefined;
        let fallbackAfterInternalNoGeneration = false;
        if (reviewLoopEnabled && reviewLoopMaxIterations > 0) {
            const workflowPolicy: WorkflowPolicy = {
                enablePlanning: false,
                enableToolUse: false,
                enableReplanning: false,
                enableGeneration: true,
                enableAssessment: true,
                enableRevision: true,
            };
            const workflowResult = await runReviewWorkflow({
                generationRuntime,
                generationRequest,
                messagesWithHints,
                generationStartedAtMs: generationStartedAt,
                workflowConfig: {
                    workflowName: REVIEW_WORKFLOW_NAME,
                    maxIterations: reviewLoopMaxIterations,
                    maxDurationMs: reviewLoopMaxDurationMs,
                },
                workflowPolicy,
                captureUsage: (result, requestedModel) =>
                    recordUsageForStep(result, requestedModel),
            });
            switch (workflowResult.outcome) {
                case 'generated':
                    generationResult = workflowResult.generationResult;
                    workflowLineage = workflowResult.workflowLineage;
                    break;
                case 'no_generation': {
                    workflowLineage = workflowResult.workflowLineage;
                    const noGenerationResolution =
                        resolveNoGenerationHandlingFromTermination({
                            terminationReason:
                                workflowResult.workflowLineage
                                    .terminationReason,
                            generationEnabledByPolicy:
                                workflowPolicy.enableGeneration !== false,
                        });
                    if (
                        noGenerationResolution.kind ===
                        'unsupported_termination_reason'
                    ) {
                        logger.error(
                            `Unsupported no-generation termination reason: ${noGenerationResolution.terminationReason}`
                        );
                        generationResult = {
                            text: SURFACED_NO_GENERATION_MESSAGE,
                            model: generationRequest.model,
                            provenance: 'Inferred',
                            citations: [],
                        };
                        break;
                    }

                    const handling =
                        WORKFLOW_NO_GENERATION_HANDLING_MAP[
                            noGenerationResolution.reasonCode
                        ];

                    if (handling.runtimeAction === 'run_fallback_generation') {
                        generationResult =
                            await generationRuntime.generate(generationRequest);
                        recordUsageForStep(
                            generationResult,
                            generationRequest.model
                        );
                        fallbackAfterInternalNoGeneration = true;
                        break;
                    }

                    generationResult = {
                        text: SURFACED_NO_GENERATION_MESSAGE,
                        model: generationRequest.model,
                        provenance: 'Inferred',
                        citations: [],
                    };
                    break;
                }
                default: {
                    const exhaustiveCheck: never = workflowResult;
                    throw new Error(
                        `Unsupported workflow outcome: ${JSON.stringify(exhaustiveCheck)}`
                    );
                }
            }
        } else {
            generationResult =
                await generationRuntime.generate(generationRequest);
            recordUsageForStep(generationResult, generationRequest.model);
        }
        const assistantMetadata = buildAssistantMetadata(
            generationResult,
            normalizedGeneration,
            generationRequest.model
        );

        // Generation duration is measured at the runtime boundary only.
        // It intentionally excludes planner time and pre/post processing.
        const generationDurationMs = Date.now() - generationStartedAt;
        const totalDurationMs =
            orchestrationStartedAtMs !== undefined
                ? Math.max(0, Date.now() - orchestrationStartedAtMs)
                : undefined;
        const retrievalUsed =
            generationResult.retrieval?.used === true ||
            generationResult.provenance === 'Retrieved' ||
            (generationResult.citations?.length ?? 0) > 0;
        const hasSearchIntent = normalizedGeneration?.search !== undefined;
        const upstreamToolExecution = executionContext?.tool;
        const effectiveToolExecutionContext:
            | NonNullable<
                  ResponseMetadataRuntimeContext['executionContext']
              >['tool']
            | undefined =
            // Respect explicit upstream tool outcomes first (for example,
            // orchestrator-level fail-open policy decisions).
            upstreamToolExecution
                ? hasSearchIntent &&
                  upstreamToolExecution.toolName === 'web_search'
                    ? {
                          ...upstreamToolExecution,
                          status: retrievalUsed ? 'executed' : 'skipped',
                          ...(retrievalUsed
                              ? upstreamToolExecution.reasonCode !== undefined
                                  ? {
                                        // Keep policy reason codes when
                                        // runtime confirms tool execution.
                                        reasonCode:
                                            upstreamToolExecution.reasonCode,
                                    }
                                  : {}
                              : {
                                    reasonCode:
                                        upstreamToolExecution.reasonCode ??
                                        'tool_not_used',
                                }),
                      }
                    : upstreamToolExecution
                : generationResult.toolExecution
                  ? generationResult.toolExecution
                  : hasSearchIntent
                    ? ({
                          // TODO(backend): Replace retrieval-signal inference
                          // with explicit runtime tool execution signals once
                          // they are always present for search requests.
                          // When search was requested, infer tool execution from
                          // retrieval usage signals reported by the runtime.
                          toolName: 'web_search',
                          status: retrievalUsed ? 'executed' : 'skipped',
                          ...(retrievalUsed
                              ? {}
                              : {
                                    reasonCode: 'tool_not_used',
                                }),
                      } satisfies ToolExecutionContext)
                    : undefined;

        const usageModel = assistantMetadata.model || defaultModel;
        type GenerationExecutionContext = NonNullable<
            NonNullable<ResponseMetadataRuntimeContext['executionContext']>['generation']
        >;
        const effectiveGenerationExecutionContext = executionContext?.generation
            ? {
                  ...executionContext.generation,
                  model: usageModel,
                  durationMs: generationDurationMs,
              }
            : fallbackAfterInternalNoGeneration
              ? ({
                    status: 'executed',
                    profileId: 'workflow_internal_fallback',
                    provider: 'internal',
                    model: usageModel,
                    durationMs: generationDurationMs,
                } satisfies GenerationExecutionContext)
              : undefined;

        const runtimeContext: ResponseMetadataRuntimeContext = {
            modelVersion: usageModel,
            conversationSnapshot: `${conversationSnapshot}\n\n${generationResult.text}`,
            ...(totalDurationMs !== undefined && { totalDurationMs }),
            plannerTemperament,
            ...(workflowLineage !== undefined && {
                workflow: workflowLineage,
            }),
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
        const finalToolExecutionTelemetry:
            | FinalToolExecutionTelemetry
            | undefined =
            effectiveToolExecutionContext !== undefined
                ? {
                      toolName: effectiveToolExecutionContext.toolName,
                      status: effectiveToolExecutionContext.status,
                      ...(effectiveToolExecutionContext.reasonCode !==
                          undefined && {
                          reasonCode: effectiveToolExecutionContext.reasonCode,
                      }),
                      ...(toolRequest !== undefined && {
                          eligible: toolRequest.eligible,
                      }),
                      ...(toolRequest?.reasonCode !== undefined && {
                          requestReasonCode: toolRequest.reasonCode,
                      }),
                  }
                : undefined;

        // Metadata is the contract that downstream UIs and trace storage rely on.
        const responseMetadata = buildResponseMetadata(
            assistantMetadata,
            runtimeContext
        );
        const safetyTierRank: Record<SafetyTier, number> = {
            Low: 1,
            Medium: 2,
            High: 3,
        };
        const shouldRaiseSafetyTier =
            safetyTier &&
            (!responseMetadata.safetyTier ||
                safetyTierRank[safetyTier] >
                    safetyTierRank[responseMetadata.safetyTier]);
        // Planner may raise risk posture for this response, but we do not
        // downgrade a higher metadata risk tier that was already derived.
        const normalizedResponseMetadata: ResponseMetadata =
            shouldRaiseSafetyTier
                ? {
                      ...responseMetadata,
                      safetyTier,
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
            ...(finalToolExecutionTelemetry !== undefined && {
                finalToolExecutionTelemetry,
            }),
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
