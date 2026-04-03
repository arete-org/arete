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
    ExecutionReasonCode,
    PartialResponseTemperament,
    ResponseMetadata,
    SafetyTier,
    StepRecord,
    ToolExecutionContext,
    ToolInvocationRequest,
    WorkflowRecord,
    WorkflowTerminationReason,
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
    applyStepExecutionToState,
    createInitialWorkflowState,
    isTransitionAllowed,
    isWithinExecutionLimits,
    mapExhaustedLimitToTerminationReason,
    type ExecutionLimits,
    type WorkflowPolicy,
} from './workflowEngine.js';
import { logger } from '../utils/logger.js';
import { runtimeConfig } from '../config.js';

const REVIEW_WORKFLOW_NAME = 'message_with_review_loop_v1';
const REVIEW_DECISION_PROMPT = `Return plain JSON only.
Schema:
{
  "decision": "finalize" | "revise",
  "reason": "one short sentence"
}
Choose "finalize" when the draft is complete, accurate, and ready.
Choose "revise" only when one additional revision would materially improve quality.
Do not include markdown or extra keys.`;

const REVISION_PROMPT_PREFIX =
    'Revise the prior draft using the review guidance while preserving factual grounding and provenance boundaries.';
const UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

type ReviewDecision = {
    decision: 'finalize' | 'revise';
    reason: string;
};

const parseReviewDecision = (text: string): ReviewDecision | null => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmed) as {
            decision?: unknown;
            reason?: unknown;
        };
        if (
            (parsed.decision !== 'finalize' && parsed.decision !== 'revise') ||
            typeof parsed.reason !== 'string' ||
            parsed.reason.trim().length === 0
        ) {
            return null;
        }

        return {
            decision: parsed.decision,
            reason: parsed.reason.trim(),
        };
    } catch {
        return null;
    }
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
        let generationResult =
            await generationRuntime.generate(generationRequest);
        let assistantMetadata = buildAssistantMetadata(
            generationResult,
            normalizedGeneration,
            generationRequest.model
        );
        let workflowLineage: WorkflowRecord | undefined;

        const reviewLoopEnabled = chatWorkflowConfig.reviewLoopEnabled;
        const reviewLoopMaxIterations = chatWorkflowConfig.maxIterations;
        const reviewLoopMaxDurationMs = chatWorkflowConfig.maxDurationMs;
        if (reviewLoopEnabled && reviewLoopMaxIterations > 0) {
            const workflowStartedAt = Date.now();
            const workflowId = `wf_${workflowStartedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            const workflowSteps: StepRecord[] = [];
            let stepCounter = 0;
            let terminationReason: WorkflowTerminationReason =
                'budget_exhausted_steps';
            let workflowStatus: WorkflowRecord['status'] = 'degraded';
            let draftResult: GenerationResult = generationResult;
            let draftParentStepId: string | undefined;
            let latestReviewReason: string | undefined;
            let shouldStop = false;
            const workflowPolicy: WorkflowPolicy = {
                enablePlanning: false,
                enableToolUse: false,
                enableReplanning: false,
                enableAssessment: true,
                enableRevision: true,
            };
            const executionLimits: ExecutionLimits = {
                maxWorkflowSteps: reviewLoopMaxIterations * 2 + 1,
                // Review-loop profile has no tool phase yet; keep tool limits inert
                // until `tool` steps are routed through the engine.
                maxToolCalls: UNBOUNDED_LIMIT,
                maxDeliberationCalls: reviewLoopMaxIterations * 2,
                // Token caps are intentionally deferred in this profile; current
                // bounded behavior is steps + deliberation calls + duration.
                maxTokensTotal: UNBOUNDED_LIMIT,
                maxDurationMs: reviewLoopMaxDurationMs,
            };
            let workflowState = createInitialWorkflowState({
                workflowId,
                workflowName: REVIEW_WORKFLOW_NAME,
                startedAtMs: workflowStartedAt,
            });

            const captureStep = (input: {
                stepKind: StepRecord['stepKind'];
                status: StepRecord['outcome']['status'];
                summary: string;
                startedAtMs: number;
                finishedAtMs: number;
                model?: string;
                usage?: GenerationResult['usage'];
                estimatedCost?: ReturnType<typeof estimateBackendTextCost>;
                reasonCode?: ExecutionReasonCode;
                parentStepId?: string;
                attempt: number;
                signals?: Record<string, string | number | boolean | null>;
                recommendations?: string[];
            }): string => {
                stepCounter += 1;
                const stepId = `step_${stepCounter}`;
                workflowSteps.push({
                    stepId,
                    ...(input.parentStepId !== undefined && {
                        parentStepId: input.parentStepId,
                    }),
                    attempt: input.attempt,
                    stepKind: input.stepKind,
                    ...(input.reasonCode !== undefined && {
                        reasonCode: input.reasonCode,
                    }),
                    startedAt: new Date(input.startedAtMs).toISOString(),
                    finishedAt: new Date(input.finishedAtMs).toISOString(),
                    durationMs: Math.max(
                        0,
                        input.finishedAtMs - input.startedAtMs
                    ),
                    ...(input.model !== undefined && { model: input.model }),
                    ...(input.usage !== undefined && {
                        usage: {
                            promptTokens: input.usage.promptTokens,
                            completionTokens: input.usage.completionTokens,
                            totalTokens: input.usage.totalTokens,
                        },
                    }),
                    ...(input.estimatedCost !== undefined && {
                        cost: {
                            inputCostUsd: input.estimatedCost.inputCostUsd,
                            outputCostUsd: input.estimatedCost.outputCostUsd,
                            totalCostUsd: input.estimatedCost.totalCostUsd,
                        },
                    }),
                    outcome: {
                        status: input.status,
                        summary: input.summary,
                        ...(input.signals !== undefined && {
                            signals: input.signals,
                        }),
                        ...(input.recommendations !== undefined && {
                            recommendations: input.recommendations,
                        }),
                    },
                });
                return stepId;
            };

            const initialDraftUsage = recordUsageForStep(
                draftResult,
                generationRequest.model
            );
            if (
                !isTransitionAllowed(
                    workflowState.currentStepKind,
                    'generate',
                    workflowPolicy
                )
            ) {
                terminationReason = 'transition_blocked_by_policy';
                workflowStatus = 'degraded';
                shouldStop = true;
            }
            const initialDraftStepId = captureStep({
                stepKind: 'generate',
                status: 'executed',
                summary: 'Generated initial draft response.',
                startedAtMs: generationStartedAt,
                finishedAtMs: Date.now(),
                model: initialDraftUsage.model,
                usage: draftResult.usage,
                estimatedCost: initialDraftUsage.estimatedCost,
                attempt: 1,
            });
            draftParentStepId = initialDraftStepId;
            workflowState = applyStepExecutionToState(
                workflowState,
                'generate',
                initialDraftUsage.totalTokens,
                0,
                0
            );

            const stopIfOverLimits = (): boolean => {
                const limitsCheck = isWithinExecutionLimits(
                    workflowState,
                    executionLimits,
                    Date.now()
                );
                if (limitsCheck.withinLimits) {
                    return false;
                }

                terminationReason =
                    limitsCheck.exhaustedBy !== undefined
                        ? mapExhaustedLimitToTerminationReason(
                              limitsCheck.exhaustedBy
                          )
                        : 'budget_exhausted_steps';
                workflowStatus = 'degraded';
                shouldStop = true;
                return true;
            };

            for (
                let iteration = 1;
                iteration <= reviewLoopMaxIterations && !shouldStop;
                iteration += 1
            ) {
                if (
                    !isTransitionAllowed(
                        workflowState.currentStepKind,
                        'assess',
                        workflowPolicy
                    )
                ) {
                    terminationReason = 'transition_blocked_by_policy';
                    workflowStatus = 'degraded';
                    break;
                }

                if (stopIfOverLimits()) {
                    break;
                }

                const reviewStartedAt = Date.now();
                try {
                    const reviewResult = await generationRuntime.generate({
                        messages: [
                            ...messagesWithHints,
                            {
                                role: 'assistant',
                                content: draftResult.text,
                            },
                            {
                                role: 'system',
                                content: REVIEW_DECISION_PROMPT,
                            },
                        ],
                        model: generationRequest.model,
                        ...(generationRequest.provider !== undefined && {
                            provider: generationRequest.provider,
                        }),
                        ...(generationRequest.capabilities !== undefined && {
                            capabilities: generationRequest.capabilities,
                        }),
                        maxOutputTokens: 200,
                        reasoningEffort: 'low',
                        verbosity: 'low',
                    });
                    const reviewFinishedAt = Date.now();
                    const reviewUsage = recordUsageForStep(
                        reviewResult,
                        generationRequest.model
                    );
                    const reviewStepId = captureStep({
                        stepKind: 'assess',
                        status: 'executed',
                        summary:
                            'Assessment step evaluated draft quality and goal completion.',
                        startedAtMs: reviewStartedAt,
                        finishedAtMs: reviewFinishedAt,
                        model: reviewUsage.model,
                        usage: reviewResult.usage,
                        estimatedCost: reviewUsage.estimatedCost,
                        parentStepId: draftParentStepId,
                        attempt: iteration,
                    });
                    workflowState = applyStepExecutionToState(
                        workflowState,
                        'assess',
                        reviewUsage.totalTokens,
                        0,
                        1
                    );
                    const decision = parseReviewDecision(reviewResult.text);
                    if (!decision) {
                        terminationReason = 'executor_error_fail_open';
                        workflowStatus = 'degraded';
                        shouldStop = true;
                        break;
                    }

                    latestReviewReason = decision.reason;
                    if (decision.decision === 'finalize') {
                        terminationReason = 'goal_satisfied';
                        workflowStatus = 'completed';
                        shouldStop = true;
                        break;
                    }

                    if (iteration >= reviewLoopMaxIterations) {
                        terminationReason = 'budget_exhausted_steps';
                        workflowStatus = 'degraded';
                        shouldStop = true;
                        break;
                    }

                    if (
                        !isTransitionAllowed(
                            workflowState.currentStepKind,
                            'revise',
                            workflowPolicy
                        )
                    ) {
                        terminationReason = 'transition_blocked_by_policy';
                        workflowStatus = 'degraded';
                        shouldStop = true;
                        break;
                    }

                    if (stopIfOverLimits()) {
                        break;
                    }

                    const revisionStartedAt = Date.now();
                    try {
                        const revisionResult = await generationRuntime.generate(
                            {
                                ...generationRequest,
                                messages: [
                                    ...messagesWithHints,
                                    {
                                        role: 'assistant',
                                        content: draftResult.text,
                                    },
                                    {
                                        role: 'system',
                                        content: `${REVISION_PROMPT_PREFIX}\nReview guidance: ${latestReviewReason ?? 'No additional guidance provided.'}`,
                                    },
                                ],
                            }
                        );
                        const revisionFinishedAt = Date.now();
                        const revisionUsage = recordUsageForStep(
                            revisionResult,
                            generationRequest.model
                        );
                        const revisionStepId = captureStep({
                            stepKind: 'revise',
                            status: 'executed',
                            summary:
                                'Revision step produced improved draft from assessment guidance.',
                            startedAtMs: revisionStartedAt,
                            finishedAtMs: revisionFinishedAt,
                            model: revisionUsage.model,
                            usage: revisionResult.usage,
                            estimatedCost: revisionUsage.estimatedCost,
                            parentStepId: reviewStepId,
                            attempt: iteration,
                            signals: {
                                        reviewReason:
                                            latestReviewReason ??
                                            'No additional guidance provided.',
                            },
                        });
                        workflowState = applyStepExecutionToState(
                            workflowState,
                            'revise',
                            revisionUsage.totalTokens,
                            0,
                            1
                        );
                        draftResult = revisionResult;
                        draftParentStepId = revisionStepId;
                    } catch {
                        const revisionFinishedAt = Date.now();
                        captureStep({
                            stepKind: 'revise',
                            status: 'failed',
                            summary:
                                'Revision step failed; fail-open returned latest successful draft.',
                            reasonCode: 'generation_runtime_error',
                            startedAtMs: revisionStartedAt,
                            finishedAtMs: revisionFinishedAt,
                            parentStepId: reviewStepId,
                            attempt: iteration,
                        });
                        workflowState = applyStepExecutionToState(
                            workflowState,
                            'revise',
                            0,
                            0,
                            1
                        );
                        terminationReason = 'executor_error_fail_open';
                        workflowStatus = 'degraded';
                        shouldStop = true;
                    }
                } catch {
                    const reviewFinishedAt = Date.now();
                    captureStep({
                        stepKind: 'assess',
                        status: 'failed',
                        summary:
                            'Assessment step failed; fail-open returned latest successful draft.',
                        reasonCode: 'generation_runtime_error',
                        startedAtMs: reviewStartedAt,
                        finishedAtMs: reviewFinishedAt,
                        parentStepId: draftParentStepId,
                        attempt: iteration,
                    });
                    workflowState = applyStepExecutionToState(
                        workflowState,
                        'assess',
                        0,
                        0,
                        1
                    );
                    terminationReason = 'executor_error_fail_open';
                    workflowStatus = 'degraded';
                    shouldStop = true;
                }
            }

            generationResult = draftResult;
            assistantMetadata = buildAssistantMetadata(
                generationResult,
                normalizedGeneration,
                generationRequest.model
            );
            workflowLineage = {
                workflowId,
                workflowName: REVIEW_WORKFLOW_NAME,
                status: workflowStatus,
                stepCount: workflowState.stepCount,
                maxSteps: executionLimits.maxWorkflowSteps,
                maxDurationMs: reviewLoopMaxDurationMs,
                terminationReason,
                steps: workflowSteps,
            };
        } else {
            recordUsageForStep(generationResult, generationRequest.model);
        }

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
        const effectiveGenerationExecutionContext = executionContext?.generation
            ? {
                  ...executionContext.generation,
                  model: usageModel,
                  durationMs: generationDurationMs,
              }
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
