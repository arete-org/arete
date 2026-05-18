/**
 * @description: Executes the bounded assess/revise loop for reviewed workflow runs.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineReviewLoopExecutor
 * @footnote-risk: medium - Loop regressions can change termination/fail-open behavior.
 * @footnote-ethics: high - Review loop controls bounded deliberation and safety posture.
 */
import type {
    ExecutionReasonCode,
    StepRecord,
    WorkflowTerminationReason,
} from '@footnote/contracts/policy';
import type {
    GenerationRequest,
    GenerationResult,
    GenerationRuntime,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type { ModelProfile } from '@footnote/contracts';
import {
    composeAssessPrompt,
    composeRefinementPrompt,
} from '../prompts/reviewPromptComposer.js';
import { buildPlannerStepRecord } from './plannerStepRecord.js';
import type {
    PlanContinuation,
    PlanContinuationBuilder,
    PlannerStepExecutor,
    PlannerStepRequest,
} from '../plannerWorkflowSeams.js';
import type { ConversationContextEnvelope } from '../conversationContextService.js';
import type { ReviewDecision } from './reviewDecision.js';
import { isWorkflowTransitionAllowed } from './transitions.js';
import { applyStepExecutionToState, type WorkflowState } from './state.js';
import type { WorkflowRunPolicy } from '../workflowEngine.js';
import { buildAssessSignals } from './reviewLoopSignals.js';
import { executeStepRoutingChain } from '../stepRoutingExecutor.js';
import type { ResolvedStepRoutingCandidate } from '../stepRoutingChains.js';
import {
    decideRevisionRoutingHintLane,
    extractRoutingHintsFromAssess,
    reorderRevisionCandidatesByHintLane,
} from './revisionRoutingHints.js';

type CaptureStep = (input: {
    stepKind: 'plan' | 'tool' | 'generate' | 'assess' | 'revise' | 'finalize';
    status: 'executed' | 'failed' | 'skipped';
    summary: string;
    artifacts?: string[];
    startedAtMs: number;
    finishedAtMs: number;
    model?: string;
    usage?: GenerationResult['usage'];
    estimatedCost?: {
        inputCostUsd: number;
        outputCostUsd: number;
        totalCostUsd: number;
    };
    reasonCode?: ExecutionReasonCode;
    parentStepId?: string;
    attempt: number;
    signals?: Record<string, string | number | boolean | null>;
    recommendations?: string[];
}) => string;

type LimitStopEvaluation = {
    stopped: boolean;
    shouldStop: boolean;
    terminationReason: WorkflowTerminationReason;
    workflowStatus: 'completed' | 'degraded';
    exhaustedLimitKey?:
        | 'maxWorkflowSteps'
        | 'maxToolCalls'
        | 'maxDeliberationCalls'
        | 'maxTokensTotal'
        | 'maxDurationMs';
};

/**
 * Executes the assess/revise loop and returns the updated workflow state bag.
 * The loop remains fail-open: generation/review/planner runtime failures are
 * converted into degraded termination instead of throwing. Policy and
 * transition authority comes from `workflowPolicy`, `stopIfOverLimits`,
 * `effectiveParseReviewDecision`, and optional planner re-entry seams.
 */
export const executeReviewLoop = async (ctx: {
    effectiveMaxIterations: number;
    workflowPolicy: WorkflowRunPolicy;
    stopIfOverLimits: (
        nextStepKind?:
            | 'plan'
            | 'tool'
            | 'generate'
            | 'assess'
            | 'revise'
            | 'finalize'
    ) => LimitStopEvaluation;
    selectedReviewModuleIds: string[];
    effectiveReviewDecisionPrompt?: string;
    generationRuntime: GenerationRuntime;
    messagesWithContext: RuntimeMessage[];
    draftResult: GenerationResult | null;
    effectiveGenerationRequest: GenerationRequest;
    captureUsage: (
        result: GenerationResult,
        requestedModel: string | undefined
    ) => {
        model: string;
        totalTokens: number;
        estimatedCost: {
            inputCostUsd: number;
            outputCostUsd: number;
            totalCostUsd: number;
        };
    };
    effectiveParseReviewDecision: (text: string) => ReviewDecision | null;
    captureStep: CaptureStep;
    draftParentStepId?: string;
    terminationReason: WorkflowTerminationReason;
    workflowStatus: 'completed' | 'degraded';
    shouldStop: boolean;
    workflowState: WorkflowState;
    exhaustedLimitKey?:
        | 'maxWorkflowSteps'
        | 'maxToolCalls'
        | 'maxDeliberationCalls'
        | 'maxTokensTotal'
        | 'maxDurationMs';
    plannerStepRequest?: PlannerStepRequest;
    plannerStepExecutor?: PlannerStepExecutor;
    planContinuationBuilder?: PlanContinuationBuilder;
    workflowId: string;
    workflowName: string;
    effectiveMessagesWithHints: RuntimeMessage[];
    effectiveContextEnvelope: ConversationContextEnvelope;
    effectiveRevisionPromptPrefix: string;
    stepCounterRef: { value: number };
    workflowStepsRef: { value: StepRecord[] };
    planContinuation?: PlanContinuation;
    stepRoutingChainSet?: {
        enabledProfilesById: Map<string, ModelProfile>;
        generateCandidates: ResolvedStepRoutingCandidate[];
        assessCandidates: ResolvedStepRoutingCandidate[];
    };
}): Promise<{
    stepCounter: number;
    messagesWithContext: RuntimeMessage[];
    draftResult: GenerationResult | null;
    draftParentStepId?: string;
    terminationReason: WorkflowTerminationReason;
    workflowStatus: 'completed' | 'degraded';
    shouldStop: boolean;
    workflowState: WorkflowState;
    exhaustedLimitKey?:
        | 'maxWorkflowSteps'
        | 'maxToolCalls'
        | 'maxDeliberationCalls'
        | 'maxTokensTotal'
        | 'maxDurationMs';
    effectiveGenerationRequest: GenerationRequest;
    effectiveMessagesWithHints: RuntimeMessage[];
    effectiveContextEnvelope: ConversationContextEnvelope;
    planContinuation?: PlanContinuation;
}> => {
    let {
        messagesWithContext,
        draftResult,
        draftParentStepId,
        terminationReason,
        workflowStatus,
        shouldStop,
        workflowState,
        exhaustedLimitKey,
        effectiveGenerationRequest,
        effectiveMessagesWithHints,
        effectiveContextEnvelope,
        planContinuation,
    } = ctx;
    let latestRevisionInstruction: string | undefined;
    let latestAssessRoutingHintsCsv: string | undefined;
    let latestRoutingHintApplied:
        | 'openai_first_logic'
        | 'ollama_first_style'
        | 'cheaper_first'
        | 'none'
        | undefined;
    let latestRoutingHintConflictResolved: 'logic_over_style' | undefined;
    const syncLimitStop = (evaluation: LimitStopEvaluation): boolean => {
        if (!evaluation.stopped) {
            return false;
        }
        shouldStop = evaluation.shouldStop;
        terminationReason = evaluation.terminationReason;
        workflowStatus = evaluation.workflowStatus;
        exhaustedLimitKey = evaluation.exhaustedLimitKey;
        return true;
    };

    for (
        let iteration = 1;
        iteration <= ctx.effectiveMaxIterations && !shouldStop;
        iteration += 1
    ) {
        if (
            !isWorkflowTransitionAllowed(
                workflowState.currentStepKind,
                'assess',
                ctx.workflowPolicy
            )
        ) {
            terminationReason = 'transition_blocked_by_policy';
            workflowStatus = 'degraded';
            break;
        }
        if (syncLimitStop(ctx.stopIfOverLimits('assess'))) {
            break;
        }
        const reviewStartedAt = Date.now();
        try {
            const assessPrompt = composeAssessPrompt({
                moduleIds: ctx.selectedReviewModuleIds,
                basePromptOverride: ctx.effectiveReviewDecisionPrompt,
            });
            const assessRequest: GenerationRequest = {
                messages: [
                    ...messagesWithContext,
                    { role: 'assistant', content: draftResult?.text ?? '' },
                    { role: 'system', content: assessPrompt.prompt },
                ],
                model: effectiveGenerationRequest.model,
                ...(effectiveGenerationRequest.provider !== undefined && {
                    provider: effectiveGenerationRequest.provider,
                }),
                ...(effectiveGenerationRequest.capabilities !== undefined && {
                    capabilities: effectiveGenerationRequest.capabilities,
                }),
                maxOutputTokens: 200,
                reasoningEffort: 'low',
                verbosity: 'low',
            };
            const assessChainResult =
                ctx.stepRoutingChainSet?.assessCandidates &&
                ctx.stepRoutingChainSet.assessCandidates.length > 0
                    ? await executeStepRoutingChain({
                          step: 'assess',
                          candidates: ctx.stepRoutingChainSet.assessCandidates,
                          enabledProfilesById:
                              ctx.stepRoutingChainSet.enabledProfilesById,
                          requiresSearch: false,
                          runWithProfile: async (profile) =>
                              ctx.generationRuntime.generate({
                                  ...assessRequest,
                                  model: profile.providerModel,
                                  provider: profile.provider,
                                  capabilities: profile.capabilities,
                              }),
                      })
                    : undefined;
            if (assessChainResult?.status === 'exhausted') {
                throw new Error(assessChainResult.reasonCode);
            }
            const reviewResult =
                assessChainResult?.status === 'executed'
                    ? assessChainResult.value
                    : await ctx.generationRuntime.generate(assessRequest);
            const reviewFinishedAt = Date.now();
            const reviewUsage = ctx.captureUsage(
                reviewResult,
                effectiveGenerationRequest.model
            );
            workflowState = applyStepExecutionToState(
                workflowState,
                'assess',
                reviewUsage.totalTokens,
                0,
                1
            );
            const decision = ctx.effectiveParseReviewDecision(
                reviewResult.text
            );
            if (!decision) {
                ctx.captureStep({
                    stepKind: 'assess',
                    status: 'failed',
                    summary:
                        'Assessment step returned invalid decision output; fail-open returned latest successful draft.',
                    reasonCode: 'generation_runtime_error',
                    startedAtMs: reviewStartedAt,
                    finishedAtMs: reviewFinishedAt,
                    model: reviewUsage.model,
                    usage: reviewResult.usage,
                    estimatedCost: reviewUsage.estimatedCost,
                    parentStepId: draftParentStepId,
                    attempt: iteration,
                });
                terminationReason = 'executor_error_fail_open';
                workflowStatus = 'degraded';
                shouldStop = true;
                break;
            }
            const assessSignals = buildAssessSignals(decision);
            const assessRoutingHints = extractRoutingHintsFromAssess({
                assessRawText: reviewResult.text,
                reviewDecision: decision,
            });
            const hintDecision =
                decideRevisionRoutingHintLane(assessRoutingHints);
            latestAssessRoutingHintsCsv =
                assessRoutingHints.length > 0
                    ? assessRoutingHints.join(',')
                    : undefined;
            latestRoutingHintApplied = hintDecision.lane;
            latestRoutingHintConflictResolved = hintDecision.conflictResolved;
            const reviewStepId = ctx.captureStep({
                stepKind: 'assess',
                status: 'executed',
                summary:
                    'Assessment step evaluated draft quality and emitted Reviewed decision.',
                startedAtMs: reviewStartedAt,
                finishedAtMs: reviewFinishedAt,
                model: reviewUsage.model,
                usage: reviewResult.usage,
                estimatedCost: reviewUsage.estimatedCost,
                parentStepId: draftParentStepId,
                attempt: iteration,
                signals: {
                    ...assessSignals,
                    ...(latestAssessRoutingHintsCsv !== undefined && {
                        assessRoutingHintsCsv: latestAssessRoutingHintsCsv,
                    }),
                    routingHintApplied: latestRoutingHintApplied ?? 'none',
                    ...(latestRoutingHintConflictResolved !== undefined && {
                        routingHintConflictResolved:
                            latestRoutingHintConflictResolved,
                    }),
                    ...(assessChainResult !== undefined && {
                        routingChainAttemptCount:
                            assessChainResult.attempts.length,
                        routingChainAttemptsJson: JSON.stringify(
                            assessChainResult.attempts
                        ),
                        selectedProfileId:
                            assessChainResult.status === 'executed'
                                ? assessChainResult.selected.profile.id
                                : null,
                    }),
                },
            });
            latestRevisionInstruction = decision.revisionInstruction;
            if (decision.reviewDecision === 'finalize') {
                terminationReason = 'goal_satisfied';
                workflowStatus = 'completed';
                shouldStop = true;
                break;
            }
            if (iteration >= ctx.effectiveMaxIterations) {
                terminationReason = 'budget_exhausted_steps';
                exhaustedLimitKey = 'maxWorkflowSteps';
                workflowStatus = 'degraded';
                shouldStop = true;
                break;
            }
            if (!ctx.workflowPolicy.enableRevision) {
                terminationReason = 'transition_blocked_by_policy';
                workflowStatus = 'degraded';
                shouldStop = true;
                break;
            }
            if (
                !isWorkflowTransitionAllowed(
                    workflowState.currentStepKind,
                    'generate',
                    ctx.workflowPolicy
                )
            ) {
                terminationReason = 'transition_blocked_by_policy';
                workflowStatus = 'degraded';
                shouldStop = true;
                break;
            }
            if (syncLimitStop(ctx.stopIfOverLimits('generate'))) {
                break;
            }
            let reentryAttempt = 0;
            if (
                ctx.plannerStepRequest !== undefined &&
                ctx.plannerStepExecutor !== undefined &&
                ctx.planContinuationBuilder !== undefined
            ) {
                if (
                    !isWorkflowTransitionAllowed(
                        workflowState.currentStepKind,
                        'plan',
                        ctx.workflowPolicy
                    )
                ) {
                    terminationReason = 'transition_blocked_by_policy';
                    workflowStatus = 'degraded';
                    shouldStop = true;
                    break;
                }
                if (syncLimitStop(ctx.stopIfOverLimits('plan'))) {
                    break;
                }
                const plannerReentryStartedAt = Date.now();
                try {
                    const plannerReentryResult = await ctx.plannerStepExecutor({
                        ...ctx.plannerStepRequest,
                        workflowId: ctx.workflowId,
                        workflowName: ctx.workflowName,
                        attempt: iteration + 1,
                    });
                    const plannerReentryFinishedAt = Date.now();
                    const plannerReentryStep = buildPlannerStepRecord({
                        stepId: `step_${ctx.stepCounterRef.value + 1}`,
                        attempt: iteration + 1,
                        parentStepId: reviewStepId,
                        startedAtMs: plannerReentryStartedAt,
                        finishedAtMs: plannerReentryFinishedAt,
                        summary: {
                            status: plannerReentryResult.execution.status,
                            ...(plannerReentryResult.execution.reasonCode !==
                                undefined && {
                                reasonCode:
                                    plannerReentryResult.execution.reasonCode,
                            }),
                            purpose: plannerReentryResult.execution.purpose,
                            contractType:
                                plannerReentryResult.execution.contractType,
                            applyOutcome:
                                plannerReentryResult.execution.status ===
                                'executed'
                                    ? 'applied'
                                    : 'not_applied',
                            durationMs:
                                plannerReentryResult.execution.durationMs,
                            action: plannerReentryResult.plan.action,
                            modality: plannerReentryResult.plan.modality,
                            requestedCapabilityProfile:
                                plannerReentryResult.plan
                                    .requestedCapabilityProfile,
                            ...(plannerReentryResult.execution
                                .routingChainAttempts !== undefined && {
                                routingChainAttempts:
                                    plannerReentryResult.execution
                                        .routingChainAttempts,
                            }),
                        },
                    });
                    ctx.workflowStepsRef.value.push(plannerReentryStep);
                    ctx.stepCounterRef.value += 1;
                    workflowState = applyStepExecutionToState(
                        workflowState,
                        'plan',
                        0,
                        0,
                        1
                    );
                    planContinuation = ctx.planContinuationBuilder({
                        plannerStepResult: plannerReentryResult,
                        workflowId: ctx.workflowId,
                        workflowName: ctx.workflowName,
                        attempt: iteration + 1,
                        baseMessagesWithHints: effectiveMessagesWithHints,
                        baseGenerationRequest: effectiveGenerationRequest,
                        contextEnvelope: effectiveContextEnvelope,
                    });
                    if (planContinuation.continuation !== 'continue_message') {
                        terminationReason = 'executor_error_fail_open';
                        workflowStatus = 'degraded';
                        shouldStop = true;
                        break;
                    }
                    reentryAttempt = iteration;
                    effectiveGenerationRequest =
                        planContinuation.generationRequest;
                    effectiveMessagesWithHints =
                        planContinuation.messagesWithHints;
                    effectiveContextEnvelope = planContinuation.contextEnvelope;
                    messagesWithContext = effectiveMessagesWithHints;
                } catch {
                    terminationReason = 'executor_error_fail_open';
                    workflowStatus = 'degraded';
                    shouldStop = true;
                    break;
                }
            }
            if (syncLimitStop(ctx.stopIfOverLimits('generate'))) {
                break;
            }
            const revisionStartedAt = Date.now();
            try {
                const refinementModuleIds =
                    decision.moduleHints !== undefined &&
                    decision.moduleHints.length > 0
                        ? decision.moduleHints
                        : ctx.selectedReviewModuleIds;
                const refinementPrompt = composeRefinementPrompt({
                    revisionPromptPrefix: ctx.effectiveRevisionPromptPrefix,
                    revisionInstruction: latestRevisionInstruction,
                    moduleIds: refinementModuleIds,
                });
                const revisionRequest: GenerationRequest = {
                    ...effectiveGenerationRequest,
                    messages: [
                        ...effectiveMessagesWithHints,
                        { role: 'assistant', content: draftResult?.text ?? '' },
                        { role: 'system', content: refinementPrompt.prompt },
                    ],
                };
                const revisionChainResult =
                    ctx.stepRoutingChainSet?.generateCandidates &&
                    ctx.stepRoutingChainSet.generateCandidates.length > 0
                        ? await executeStepRoutingChain({
                              step: 'generate',
                              candidates: reorderRevisionCandidatesByHintLane({
                                  candidates:
                                      ctx.stepRoutingChainSet
                                          .generateCandidates,
                                  enabledProfilesById:
                                      ctx.stepRoutingChainSet
                                          .enabledProfilesById,
                                  lane: latestRoutingHintApplied ?? 'none',
                              }),
                              enabledProfilesById:
                                  ctx.stepRoutingChainSet.enabledProfilesById,
                              requiresSearch:
                                  revisionRequest.search !== undefined,
                              runWithProfile: async (profile) =>
                                  ctx.generationRuntime.generate({
                                      ...revisionRequest,
                                      model: profile.providerModel,
                                      provider: profile.provider,
                                      capabilities: profile.capabilities,
                                  }),
                          })
                        : undefined;
                if (revisionChainResult?.status === 'exhausted') {
                    throw new Error(revisionChainResult.reasonCode);
                }
                const revisionResult =
                    revisionChainResult?.status === 'executed'
                        ? revisionChainResult.value
                        : await ctx.generationRuntime.generate(revisionRequest);
                const revisionFinishedAt = Date.now();
                const revisionUsage = ctx.captureUsage(
                    revisionResult,
                    effectiveGenerationRequest.model
                );
                const revisionStepId = ctx.captureStep({
                    stepKind: 'generate',
                    status: 'executed',
                    summary:
                        'Generated refinement draft from assessment guidance.',
                    startedAtMs: revisionStartedAt,
                    finishedAtMs: revisionFinishedAt,
                    model: revisionUsage.model,
                    usage: revisionResult.usage,
                    estimatedCost: revisionUsage.estimatedCost,
                    parentStepId: reviewStepId,
                    attempt: iteration,
                    signals: {
                        refinementApplied: true,
                        refinementSourceStepId: reviewStepId,
                        appliedModuleCount:
                            refinementPrompt.appliedModuleIds.length,
                        ...(refinementPrompt.appliedModuleIds.length > 0 && {
                            appliedModuleIdsCsv:
                                refinementPrompt.appliedModuleIds.join(','),
                        }),
                        ...(reentryAttempt > 0 && { reentryAttempt }),
                        ...(latestAssessRoutingHintsCsv !== undefined && {
                            assessRoutingHintsCsv: latestAssessRoutingHintsCsv,
                        }),
                        routingHintApplied: latestRoutingHintApplied ?? 'none',
                        ...(latestRoutingHintConflictResolved !== undefined && {
                            routingHintConflictResolved:
                                latestRoutingHintConflictResolved,
                        }),
                        ...(revisionChainResult !== undefined && {
                            routingChainAttemptCount:
                                revisionChainResult.attempts.length,
                            routingChainAttemptsJson: JSON.stringify(
                                revisionChainResult.attempts
                            ),
                            selectedProfileId:
                                revisionChainResult.status === 'executed'
                                    ? revisionChainResult.selected.profile.id
                                    : null,
                        }),
                    },
                });
                workflowState = applyStepExecutionToState(
                    workflowState,
                    'generate',
                    revisionUsage.totalTokens,
                    0,
                    0
                );
                draftResult = revisionResult;
                draftParentStepId = revisionStepId;
            } catch (error) {
                const revisionFinishedAt = Date.now();
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const reasonCode: ExecutionReasonCode =
                    errorMessage === 'routing_chain_exhausted' ||
                    errorMessage === 'routing_chain_non_transient_error'
                        ? (errorMessage as ExecutionReasonCode)
                        : 'generation_runtime_error';
                ctx.captureStep({
                    stepKind: 'generate',
                    status: 'failed',
                    summary:
                        'Refinement generation failed; fail-open returned latest successful draft.',
                    reasonCode,
                    startedAtMs: revisionStartedAt,
                    finishedAtMs: revisionFinishedAt,
                    parentStepId: reviewStepId,
                    attempt: iteration,
                    signals: {
                        ...(latestAssessRoutingHintsCsv !== undefined && {
                            assessRoutingHintsCsv: latestAssessRoutingHintsCsv,
                        }),
                        routingHintApplied: latestRoutingHintApplied ?? 'none',
                        ...(latestRoutingHintConflictResolved !== undefined && {
                            routingHintConflictResolved:
                                latestRoutingHintConflictResolved,
                        }),
                    },
                });
                workflowState = applyStepExecutionToState(
                    workflowState,
                    'generate',
                    0,
                    0,
                    0
                );
                terminationReason = 'executor_error_fail_open';
                workflowStatus = 'degraded';
                shouldStop = true;
            }
        } catch (error) {
            const reviewFinishedAt = Date.now();
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            const reasonCode: ExecutionReasonCode =
                errorMessage === 'routing_chain_exhausted' ||
                errorMessage === 'routing_chain_non_transient_error'
                    ? (errorMessage as ExecutionReasonCode)
                    : 'generation_runtime_error';
            ctx.captureStep({
                stepKind: 'assess',
                status: 'failed',
                summary:
                    'Assessment step failed; fail-open returned latest successful draft.',
                reasonCode,
                startedAtMs: reviewStartedAt,
                finishedAtMs: reviewFinishedAt,
                parentStepId: draftParentStepId,
                attempt: iteration,
                signals: {
                    ...(latestAssessRoutingHintsCsv !== undefined && {
                        assessRoutingHintsCsv: latestAssessRoutingHintsCsv,
                    }),
                    routingHintApplied: latestRoutingHintApplied ?? 'none',
                    ...(latestRoutingHintConflictResolved !== undefined && {
                        routingHintConflictResolved:
                            latestRoutingHintConflictResolved,
                    }),
                },
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

    return {
        stepCounter: ctx.stepCounterRef.value,
        messagesWithContext,
        draftResult,
        draftParentStepId,
        terminationReason,
        workflowStatus,
        shouldStop,
        workflowState,
        exhaustedLimitKey,
        effectiveGenerationRequest,
        effectiveMessagesWithHints,
        effectiveContextEnvelope,
        planContinuation,
    };
};
