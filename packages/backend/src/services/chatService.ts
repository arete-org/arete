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
    TraceAxisScore,
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
import { resolveNoGenerationHandlingFromTermination } from './workflowProfileContract.js';
import { resolveWorkflowRuntimeConfig } from './workflowProfileRegistry.js';
import type { WorkflowProfileId } from './workflowProfileContract.js';
import {
    runBoundedReviewWorkflow,
    type RunBoundedReviewWorkflowResult,
    type WorkflowPolicy,
} from './workflowEngine.js';
import { runEvidenceIngestion } from './executionContractTrustGraph/trustGraphEvidenceIngestion.js';
import type {
    ScopeTuple,
    TrustGraphEvidenceAdapter,
    TrustGraphEvidenceIngestionResult,
    TrustGraphOwnershipValidationPolicy,
    ScopeOwnershipValidator,
} from './executionContractTrustGraph/trustGraphEvidenceTypes.js';
import type { ScopeValidationPolicy } from './executionContractTrustGraph/scopeValidator.js';
import { logger } from '../utils/logger.js';
import { runtimeConfig } from '../config.js';

const SURFACED_NO_GENERATION_MESSAGE =
    'I could not generate a response for this request.';

type ExecutionContractTrustGraphRuntimeOptions = {
    adapter?: TrustGraphEvidenceAdapter;
    budget: {
        timeoutMs: number;
        maxCalls: number;
    };
    ownershipValidationPolicy: TrustGraphOwnershipValidationPolicy;
    scopeOwnershipValidator?: ScopeOwnershipValidator;
    scopeValidationPolicy?: Partial<
        Pick<
            ScopeValidationPolicy,
            | 'requireProjectOrCollection'
            | 'allowProjectAndCollectionTogether'
            | 'ownershipValidationTimeoutMs'
        >
    >;
};

type ExecutionContractTrustGraphContext = {
    queryIntent: string;
    scopeTuple: ScopeTuple;
};

type TrustGraphMetadataEnvelope = {
    adapterStatus: TrustGraphEvidenceIngestionResult['adapterStatus'];
    scopeValidation: TrustGraphEvidenceIngestionResult['scopeValidation'];
    terminalAuthority: TrustGraphEvidenceIngestionResult['terminalAuthority'];
    failOpenBehavior: TrustGraphEvidenceIngestionResult['failOpenBehavior'];
    verificationRequired: TrustGraphEvidenceIngestionResult['verificationRequired'];
    advisoryEvidenceItemCount: TrustGraphEvidenceIngestionResult['advisoryEvidenceItemCount'];
    droppedEvidenceCount: TrustGraphEvidenceIngestionResult['droppedEvidenceCount'];
    droppedEvidenceIds: TrustGraphEvidenceIngestionResult['droppedEvidenceIds'];
    provenanceReasonCodes: TrustGraphEvidenceIngestionResult['provenanceReasonCodes'];
    sufficiencyView: {
        coverageValue?: number;
        coverageEvaluationUnit?: TrustGraphEvidenceIngestionResult['predicateViews']['P_SUFF']['coverageEvaluationUnit'];
        conflictSignals: string[];
    };
    evidenceView: {
        sourceRefs: string[];
        provenancePathRefs: string[];
        traceRefs: string[];
    };
    provenanceJoin?: TrustGraphEvidenceIngestionResult['provenanceJoin'];
};

type ResponseMetadataWithTrustGraph = ResponseMetadata & {
    trustGraph?: TrustGraphMetadataEnvelope;
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

const mapCoverageToTraceAxisScore = (
    coverageValue: number,
    conflictSignalsCount: number
): TraceAxisScore => {
    const normalizedPercent =
        coverageValue <= 1
            ? Math.max(0, Math.min(100, coverageValue * 100))
            : Math.max(0, Math.min(100, coverageValue));
    const baseScore =
        normalizedPercent >= 80
            ? 5
            : normalizedPercent >= 60
              ? 4
              : normalizedPercent >= 40
                ? 3
                : normalizedPercent >= 20
                  ? 2
                  : 1;

    const conflictPenalty = conflictSignalsCount > 0 ? 1 : 0;
    const clamped = Math.max(1, Math.min(5, baseScore - conflictPenalty));
    return clamped as TraceAxisScore;
};

const toPublicProvenanceJoin = (
    provenanceJoin: TrustGraphEvidenceIngestionResult['provenanceJoin']
): TrustGraphEvidenceIngestionResult['provenanceJoin'] => {
    if (provenanceJoin === undefined) {
        return undefined;
    }

    const joinRecord =
        provenanceJoin as TrustGraphEvidenceIngestionResult['provenanceJoin'] & {
            scopeTuple?: unknown;
        };
    const { scopeTuple: _scopeTuple, ...publicJoin } = joinRecord;
    return publicJoin;
};

const toPublicScopeValidation = (
    scopeValidation: TrustGraphEvidenceIngestionResult['scopeValidation']
): TrustGraphEvidenceIngestionResult['scopeValidation'] => {
    if (!scopeValidation.ok) {
        return scopeValidation;
    }

    return {
        ok: true,
        normalizedScope: {
            userId: '[redacted]',
            ...(scopeValidation.normalizedScope.projectId !== undefined && {
                projectId: '[redacted]',
            }),
            ...(scopeValidation.normalizedScope.collectionId !== undefined && {
                collectionId: '[redacted]',
            }),
        },
    };
};

const toTrustGraphMetadataEnvelope = (
    result: TrustGraphEvidenceIngestionResult
): TrustGraphMetadataEnvelope => ({
    adapterStatus: result.adapterStatus,
    scopeValidation: toPublicScopeValidation(result.scopeValidation),
    terminalAuthority: result.terminalAuthority,
    failOpenBehavior: result.failOpenBehavior,
    verificationRequired: result.verificationRequired,
    advisoryEvidenceItemCount: result.advisoryEvidenceItemCount,
    droppedEvidenceCount: result.droppedEvidenceCount,
    droppedEvidenceIds: result.droppedEvidenceIds,
    provenanceReasonCodes: result.provenanceReasonCodes,
    sufficiencyView: {
        coverageValue: result.predicateViews.P_SUFF.coverageValue,
        coverageEvaluationUnit:
            result.predicateViews.P_SUFF.coverageEvaluationUnit,
        conflictSignals: result.predicateViews.P_SUFF.conflictSignals,
    },
    evidenceView: {
        sourceRefs: result.predicateViews.P_EVID.sourceRefs,
        provenancePathRefs: result.predicateViews.P_EVID.provenancePathRefs,
        traceRefs: result.predicateViews.P_EVID.traceRefs,
    },
    provenanceJoin: toPublicProvenanceJoin(result.provenanceJoin),
});

const OWNERSHIP_DENIAL_PREFIXES: readonly string[] = [
    'tenant_mismatch:',
    'scope_not_found:',
    'validator_error:',
    'insufficient_data:',
];

const extractOwnershipDenialReason = (
    details: string | undefined
):
    | 'tenant_mismatch'
    | 'scope_not_found'
    | 'validator_error'
    | 'insufficient_data'
    | undefined => {
    if (typeof details !== 'string') {
        return undefined;
    }

    const normalized = details.trim().toLowerCase();
    for (const prefix of OWNERSHIP_DENIAL_PREFIXES) {
        if (normalized.startsWith(prefix)) {
            return prefix.slice(0, prefix.length - 1) as
                | 'tenant_mismatch'
                | 'scope_not_found'
                | 'validator_error'
                | 'insufficient_data';
        }
    }

    return undefined;
};

const logTrustGraphRuntimeOutcome = (
    result: TrustGraphEvidenceIngestionResult
): void => {
    const adapterInvoked =
        result.adapterStatus === 'success' ||
        result.adapterStatus === 'timeout' ||
        result.adapterStatus === 'error';
    const scopeValidation = result.scopeValidation;
    const scopeDenied = !scopeValidation.ok;
    let scopeDenialReasonCode: string | undefined;
    let scopeDenialDetails: string | undefined;
    if (!scopeValidation.ok) {
        scopeDenialReasonCode = scopeValidation.reasonCode;
        scopeDenialDetails = scopeValidation.details;
    }
    const ownershipDenialReason = scopeDenied
        ? extractOwnershipDenialReason(scopeDenialDetails)
        : undefined;
    const bypassDenied = result.provenanceReasonCodes.includes(
        'ownership_validation_explicitly_none_denied'
    );
    const timeout = result.adapterStatus === 'timeout';
    const adapterError = result.adapterStatus === 'error';

    const logPayload = {
        event: 'chat.execution_contract_trustgraph.runtime_outcome',
        adapterStatus: result.adapterStatus,
        adapterInvoked,
        adapterSkipped: !adapterInvoked && result.adapterStatus !== 'success',
        scopeDenied,
        scopeDenialReasonCode,
        ownershipDenied: ownershipDenialReason !== undefined,
        ownershipDenialReason,
        bypassDenied,
        timeout,
        adapterError,
        provenanceReasonCodes: result.provenanceReasonCodes,
    };

    if (scopeDenied || timeout || adapterError || bypassDenied) {
        logger.warn(logPayload);
        return;
    }

    logger.info(logPayload);
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
        profileId?: WorkflowProfileId;
        reviewLoopEnabled: boolean;
        maxIterations: number;
        maxDurationMs: number;
    };
    runReviewWorkflow?: (
        input: Parameters<typeof runBoundedReviewWorkflow>[0]
    ) => Promise<RunBoundedReviewWorkflowResult>;
    executionContractTrustGraph?: ExecutionContractTrustGraphRuntimeOptions;
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
    executionContractTrustGraphContext?: ExecutionContractTrustGraphContext;
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
    executionContractTrustGraph,
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
        executionContractTrustGraphContext,
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
        const workflowRuntimeConfig = resolveWorkflowRuntimeConfig({
            profileId: chatWorkflowConfig.profileId,
            reviewLoopEnabled: chatWorkflowConfig.reviewLoopEnabled,
            maxIterations: chatWorkflowConfig.maxIterations,
            maxDurationMs: chatWorkflowConfig.maxDurationMs,
        });
        const workflowProfile = workflowRuntimeConfig.runtimeProfile;
        const workflowExecutionEnabled =
            workflowRuntimeConfig.workflowExecutionEnabled;
        const workflowMaxIterations =
            workflowRuntimeConfig.workflowMaxIterations;
        const workflowMaxDurationMs =
            workflowRuntimeConfig.workflowMaxDurationMs;

        let generationResult: GenerationResult;
        let workflowLineage: WorkflowRecord | undefined;
        let fallbackAfterInternalNoGeneration = false;
        if (workflowExecutionEnabled) {
            const workflowPolicy: WorkflowPolicy = workflowProfile.policy;
            const workflowResult = await runReviewWorkflow({
                generationRuntime,
                generationRequest,
                messagesWithHints,
                generationStartedAtMs: generationStartedAt,
                workflowConfig: {
                    workflowName: workflowProfile.workflowName,
                    maxIterations: workflowMaxIterations,
                    maxDurationMs: workflowMaxDurationMs,
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
                            'Unsupported no-generation termination reason.',
                            {
                                workflowName: workflowProfile.workflowName,
                                terminationReason:
                                    noGenerationResolution.terminationReason,
                                noGenerationResolution,
                            }
                        );
                        generationResult = {
                            text: SURFACED_NO_GENERATION_MESSAGE,
                            model: generationRequest.model,
                            provenance: 'Inferred',
                            citations: [],
                        };
                        break;
                    }

                    const handling = noGenerationResolution.handling;

                    if (handling.runtimeAction === 'run_fallback_generation') {
                        try {
                            generationResult =
                                await generationRuntime.generate(
                                    generationRequest
                                );
                            recordUsageForStep(
                                generationResult,
                                generationRequest.model
                            );
                        } catch (error) {
                            logger.warn(
                                'Fallback generation after internal no-generation failed; preserving no-generation lineage.',
                                {
                                    workflowName: workflowProfile.workflowName,
                                    reasonCode:
                                        noGenerationResolution.reasonCode,
                                    terminationReason:
                                        workflowResult.workflowLineage
                                            .terminationReason,
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : String(error),
                                }
                            );
                            generationResult = {
                                text: SURFACED_NO_GENERATION_MESSAGE,
                                model: generationRequest.model,
                                provenance: 'Inferred',
                                citations: [],
                            };
                        }
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

        let trustGraphResult: TrustGraphEvidenceIngestionResult | undefined;
        if (
            executionContractTrustGraph !== undefined &&
            executionContractTrustGraphContext !== undefined
        ) {
            try {
                trustGraphResult = await runEvidenceIngestion({
                    queryIntent: executionContractTrustGraphContext.queryIntent,
                    scopeTuple: executionContractTrustGraphContext.scopeTuple,
                    budget: executionContractTrustGraph.budget,
                    ownershipValidationPolicy:
                        executionContractTrustGraph.ownershipValidationPolicy,
                    scopeOwnershipValidator:
                        executionContractTrustGraph.scopeOwnershipValidator,
                    scopeValidationPolicy:
                        executionContractTrustGraph.scopeValidationPolicy,
                    adapter: executionContractTrustGraph.adapter,
                });
            } catch (error) {
                logger.warn(
                    'Execution Contract TrustGraph ingestion failed open in chat runtime.',
                    {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    }
                );
            }
        }
        if (trustGraphResult !== undefined) {
            logTrustGraphRuntimeOutcome(trustGraphResult);
        }

        const assistantMetadata = buildAssistantMetadata(
            generationResult,
            normalizedGeneration,
            generationRequest.model
        );
        if (
            trustGraphResult?.adapterStatus === 'success' &&
            assistantMetadata.evidenceScore === undefined &&
            trustGraphResult.predicateViews.P_SUFF.coverageValue !== undefined
        ) {
            assistantMetadata.evidenceScore = mapCoverageToTraceAxisScore(
                trustGraphResult.predicateViews.P_SUFF.coverageValue,
                trustGraphResult.predicateViews.P_SUFF.conflictSignals.length
            );
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
            NonNullable<
                ResponseMetadataRuntimeContext['executionContext']
            >['generation']
        >;
        const upstreamGenerationExecutionContext = executionContext?.generation;
        const effectiveGenerationProfileId = fallbackAfterInternalNoGeneration
            ? 'workflow_internal_fallback'
            : (upstreamGenerationExecutionContext?.effectiveProfileId ??
              upstreamGenerationExecutionContext?.profileId);
        const effectiveGenerationExecutionContext:
            | GenerationExecutionContext
            | undefined = upstreamGenerationExecutionContext
            ? {
                  ...upstreamGenerationExecutionContext,
                  ...(upstreamGenerationExecutionContext.originalProfileId !==
                      undefined && {
                      originalProfileId:
                          upstreamGenerationExecutionContext.originalProfileId,
                  }),
                  ...(effectiveGenerationProfileId !== undefined && {
                      profileId: effectiveGenerationProfileId,
                      effectiveProfileId: effectiveGenerationProfileId,
                  }),
                  model: usageModel,
                  durationMs: generationDurationMs,
              }
            : fallbackAfterInternalNoGeneration
              ? ({
                    status: 'executed',
                    profileId: 'workflow_internal_fallback',
                    effectiveProfileId: 'workflow_internal_fallback',
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
        const metadataWithTrustGraph: ResponseMetadataWithTrustGraph =
            trustGraphResult !== undefined
                ? {
                      ...normalizedResponseMetadata,
                      trustGraph:
                          toTrustGraphMetadataEnvelope(trustGraphResult),
                  }
                : normalizedResponseMetadata;

        // Trace writes stay fire-and-forget so a storage hiccup does not block the user response.
        storeTrace(metadataWithTrustGraph).catch((error) => {
            logger.error(
                `Background trace storage error: ${error instanceof Error ? error.message : String(error)}`
            );
        });

        return {
            message: generationResult.text,
            metadata: metadataWithTrustGraph,
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
