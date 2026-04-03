/**
 * @description: Defines backend-owned workflow engine primitives for step orchestration and bounded execution.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngine
 * @footnote-risk: medium - Incorrect transition or limit logic can cause invalid workflow routes or runaway execution.
 * @footnote-ethics: high - Workflow control determines whether model-deliberative paths remain bounded and auditable.
 */
import type { WorkflowStepKind } from '@footnote/contracts/ethics-core';
import type { WorkflowTerminationReason } from '@footnote/contracts/ethics-core';
import type {
    ExecutionReasonCode,
    StepRecord,
    WorkflowRecord,
} from '@footnote/contracts/ethics-core';
import type {
    GenerationRequest,
    GenerationResult,
    GenerationRuntime,
    RuntimeMessage,
} from '@footnote/agent-runtime';

export type WorkflowPolicy = {
    enablePlanning: boolean;
    enableToolUse: boolean;
    enableReplanning: boolean;
    enableGeneration?: boolean;
    enableAssessment: boolean;
    enableRevision: boolean;
};

export type ExecutionLimits = {
    maxWorkflowSteps: number;
    maxToolCalls: number;
    maxDeliberationCalls: number;
    maxTokensTotal: number;
    maxDurationMs: number;
};

export type ExhaustedLimit =
    | 'maxWorkflowSteps'
    | 'maxToolCalls'
    | 'maxDeliberationCalls'
    | 'maxTokensTotal'
    | 'maxDurationMs';

export type WorkflowState = {
    workflowId: string;
    workflowName: string;
    startedAtMs: number;
    currentStepKind: WorkflowStepKind | null;
    stepCount: number;
    toolCallCount: number;
    deliberationCallCount: number;
    totalTokens: number;
};

export type ReviewDecision = {
    decision: 'finalize' | 'revise';
    reason: string;
};

export const DEFAULT_REVIEW_DECISION_PROMPT = `Return plain JSON only.
Schema:
{
  "decision": "finalize" | "revise",
  "reason": "one short sentence"
}
Choose "finalize" when the draft is complete, accurate, and ready.
Choose "revise" only when one additional revision would materially improve quality.
Do not include markdown or extra keys.`;

export const DEFAULT_REVISION_PROMPT_PREFIX =
    'Revise the prior draft using the review guidance while preserving factual grounding and provenance boundaries.';

export const parseReviewDecisionText = (
    text: string
): ReviewDecision | null => {
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

export type BoundedReviewProfileStrategy = {
    reviewDecisionPrompt: string;
    revisionPromptPrefix: string;
    parseReviewDecision: (text: string) => ReviewDecision | null;
};

export const BOUNDED_REVIEW_PROFILE_STRATEGY_V1: BoundedReviewProfileStrategy =
    {
        reviewDecisionPrompt: DEFAULT_REVIEW_DECISION_PROMPT,
        revisionPromptPrefix: DEFAULT_REVISION_PROMPT_PREFIX,
        parseReviewDecision: parseReviewDecisionText,
    };

export type ReviewWorkflowRuntimeConfig = {
    workflowName: string;
    maxIterations: number;
    maxDurationMs: number;
};

export type ReviewWorkflowUsageSummary = {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: {
        inputCostUsd: number;
        outputCostUsd: number;
        totalCostUsd: number;
    };
};

export type RunBoundedReviewWorkflowInput = {
    generationRuntime: GenerationRuntime;
    generationRequest: GenerationRequest;
    messagesWithHints: RuntimeMessage[];
    generationStartedAtMs: number;
    workflowConfig: ReviewWorkflowRuntimeConfig;
    workflowPolicy: WorkflowPolicy;
    profileStrategy?: BoundedReviewProfileStrategy;
    reviewDecisionPrompt?: string;
    revisionPromptPrefix?: string;
    parseReviewDecision?: (text: string) => ReviewDecision | null;
    captureUsage: (
        result: GenerationResult,
        requestedModel: string | undefined
    ) => ReviewWorkflowUsageSummary;
};

export type RunBoundedReviewWorkflowResult =
    | {
          outcome: 'generated';
          generationResult: GenerationResult;
          workflowLineage: WorkflowRecord;
      }
    | {
          outcome: 'no_generation';
          workflowLineage: WorkflowRecord;
      };

const LEGAL_TRANSITIONS: Record<
    WorkflowStepKind,
    ReadonlySet<WorkflowStepKind>
> = {
    plan: new Set(['tool', 'generate', 'assess', 'finalize']),
    tool: new Set(['tool', 'generate', 'assess', 'finalize']),
    generate: new Set(['assess', 'revise', 'finalize']),
    assess: new Set(['tool', 'generate', 'revise', 'finalize']),
    revise: new Set(['assess', 'generate', 'finalize']),
    finalize: new Set([]),
};

const isStepKindAllowedByPolicy = (
    stepKind: WorkflowStepKind,
    policy: WorkflowPolicy
): boolean => {
    if (stepKind === 'plan') {
        return policy.enablePlanning;
    }
    if (stepKind === 'tool') {
        return policy.enableToolUse;
    }
    if (stepKind === 'assess') {
        return policy.enableAssessment;
    }
    if (stepKind === 'revise') {
        return policy.enableRevision;
    }
    if (stepKind === 'generate') {
        return policy.enableGeneration !== false;
    }

    return true;
};

export const isTransitionAllowed = (
    fromStepKind: WorkflowStepKind | null,
    toStepKind: WorkflowStepKind,
    policy: WorkflowPolicy
): boolean => {
    if (!isStepKindAllowedByPolicy(toStepKind, policy)) {
        return false;
    }

    if (fromStepKind === null) {
        return toStepKind === 'plan' || toStepKind === 'generate';
    }

    if (fromStepKind === 'plan' && toStepKind === 'plan') {
        return policy.enableReplanning;
    }

    return LEGAL_TRANSITIONS[fromStepKind].has(toStepKind);
};

export const createInitialWorkflowState = (input: {
    workflowId: string;
    workflowName: string;
    startedAtMs: number;
}): WorkflowState => ({
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    startedAtMs: input.startedAtMs,
    currentStepKind: null,
    stepCount: 0,
    toolCallCount: 0,
    deliberationCallCount: 0,
    totalTokens: 0,
});

export const cloneWorkflowState = (state: WorkflowState): WorkflowState => ({
    ...state,
});

export const applyStepExecutionToState = (
    state: WorkflowState,
    stepKind: WorkflowStepKind,
    usageTokens: number,
    toolCallsExecuted: number,
    deliberationCallsExecuted: number
): WorkflowState => {
    const sanitizeDelta = (value: number): number => {
        if (!Number.isFinite(value)) {
            return 0;
        }

        return Math.max(0, Math.floor(value));
    };

    const sanitizedUsageTokens = sanitizeDelta(usageTokens);
    const sanitizedToolCallsExecuted = sanitizeDelta(toolCallsExecuted);
    const sanitizedDeliberationCallsExecuted = sanitizeDelta(
        deliberationCallsExecuted
    );

    return {
        ...state,
        currentStepKind: stepKind,
        stepCount: state.stepCount + 1,
        toolCallCount: state.toolCallCount + sanitizedToolCallsExecuted,
        deliberationCallCount:
            state.deliberationCallCount + sanitizedDeliberationCallsExecuted,
        totalTokens: state.totalTokens + sanitizedUsageTokens,
    };
};

export const isWithinExecutionLimits = (
    state: WorkflowState,
    limits: ExecutionLimits,
    nowMs: number
): {
    withinLimits: boolean;
    exhaustedBy?: ExhaustedLimit;
} => {
    if (state.stepCount >= limits.maxWorkflowSteps) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxWorkflowSteps',
        };
    }

    if (state.toolCallCount >= limits.maxToolCalls) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxToolCalls',
        };
    }

    if (state.deliberationCallCount >= limits.maxDeliberationCalls) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxDeliberationCalls',
        };
    }

    if (state.totalTokens >= limits.maxTokensTotal) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxTokensTotal',
        };
    }

    if (nowMs - state.startedAtMs >= limits.maxDurationMs) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxDurationMs',
        };
    }

    return {
        withinLimits: true,
    };
};

export const mapExhaustedLimitToTerminationReason = (
    exhaustedBy: ExhaustedLimit
): WorkflowTerminationReason => {
    if (exhaustedBy === 'maxWorkflowSteps') {
        return 'budget_exhausted_steps';
    }

    if (exhaustedBy === 'maxTokensTotal') {
        return 'budget_exhausted_tokens';
    }

    if (exhaustedBy === 'maxDurationMs') {
        return 'budget_exhausted_time';
    }

    if (exhaustedBy === 'maxToolCalls') {
        return 'max_tool_calls_reached';
    }

    if (exhaustedBy === 'maxDeliberationCalls') {
        return 'max_deliberation_calls_reached';
    }

    const exhaustiveCheck: never = exhaustedBy;
    throw new Error(
        `Unsupported exhausted execution limit: ${exhaustiveCheck}`
    );
};

export const runBoundedReviewWorkflow = async ({
    generationRuntime,
    generationRequest,
    messagesWithHints,
    generationStartedAtMs,
    workflowConfig,
    workflowPolicy,
    profileStrategy = BOUNDED_REVIEW_PROFILE_STRATEGY_V1,
    reviewDecisionPrompt,
    revisionPromptPrefix,
    parseReviewDecision,
    captureUsage,
}: RunBoundedReviewWorkflowInput): Promise<RunBoundedReviewWorkflowResult> => {
    const UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;
    const sanitizeNonNegativeInteger = (
        value: number,
        fallback: number
    ): number => {
        if (!Number.isFinite(value)) {
            return Math.max(0, Math.floor(fallback));
        }

        return Math.max(0, Math.floor(value));
    };
    const sanitizePositiveInteger = (
        value: number,
        fallback: number
    ): number => {
        if (!Number.isFinite(value)) {
            return Math.max(1, Math.floor(fallback));
        }

        return Math.max(1, Math.floor(value));
    };
    const normalizedMaxIterations = sanitizeNonNegativeInteger(
        workflowConfig.maxIterations,
        0
    );
    const normalizedMaxDurationMs = sanitizePositiveInteger(
        workflowConfig.maxDurationMs,
        15000
    );
    const workflowStartedAt = Date.now();
    const workflowId = `wf_${workflowStartedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const workflowSteps: StepRecord[] = [];
    let stepCounter = 0;
    let terminationReason: WorkflowTerminationReason = 'budget_exhausted_steps';
    let workflowStatus: WorkflowRecord['status'] = 'degraded';
    let draftResult: GenerationResult | null = null;
    let draftParentStepId: string | undefined;
    let latestReviewReason: string | undefined;
    let shouldStop = false;
    const effectiveReviewDecisionPrompt =
        reviewDecisionPrompt ?? profileStrategy.reviewDecisionPrompt;
    const effectiveRevisionPromptPrefix =
        revisionPromptPrefix ?? profileStrategy.revisionPromptPrefix;
    const effectiveParseReviewDecision =
        parseReviewDecision ?? profileStrategy.parseReviewDecision;

    const executionLimits: ExecutionLimits = {
        maxWorkflowSteps: normalizedMaxIterations * 2 + 1,
        maxToolCalls: UNBOUNDED_LIMIT,
        maxDeliberationCalls: normalizedMaxIterations * 2,
        maxTokensTotal: UNBOUNDED_LIMIT,
        maxDurationMs: normalizedMaxDurationMs,
    };
    let workflowState = createInitialWorkflowState({
        workflowId,
        workflowName: workflowConfig.workflowName,
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
        estimatedCost?: ReviewWorkflowUsageSummary['estimatedCost'];
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
            durationMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
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
                ? mapExhaustedLimitToTerminationReason(limitsCheck.exhaustedBy)
                : 'budget_exhausted_steps';
        workflowStatus = 'degraded';
        shouldStop = true;
        return true;
    };

    if (
        !isTransitionAllowed(
            workflowState.currentStepKind,
            'generate',
            workflowPolicy
        )
    ) {
        terminationReason = 'transition_blocked_by_policy';
        shouldStop = true;
    } else {
        const initialDraftStartedAt = generationStartedAtMs;
        draftResult = await generationRuntime.generate(generationRequest);
        const initialDraftFinishedAt = Date.now();
        const initialDraftUsage = captureUsage(
            draftResult,
            generationRequest.model
        );
        const initialDraftStepId = captureStep({
            stepKind: 'generate',
            status: 'executed',
            summary: 'Generated initial draft response.',
            startedAtMs: initialDraftStartedAt,
            finishedAtMs: initialDraftFinishedAt,
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
    }
    if (!shouldStop && normalizedMaxIterations === 0) {
        terminationReason = 'goal_satisfied';
        workflowStatus = 'completed';
    }

    for (
        let iteration = 1;
        iteration <= normalizedMaxIterations && !shouldStop;
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
                        content: draftResult?.text ?? '',
                    },
                    {
                        role: 'system',
                        content: effectiveReviewDecisionPrompt,
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
            const reviewUsage = captureUsage(
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
            const decision = effectiveParseReviewDecision(reviewResult.text);
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

            if (iteration >= normalizedMaxIterations) {
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
                const revisionResult = await generationRuntime.generate({
                    ...generationRequest,
                    messages: [
                        ...messagesWithHints,
                        {
                            role: 'assistant',
                            content: draftResult?.text ?? '',
                        },
                        {
                            role: 'system',
                            content: `${effectiveRevisionPromptPrefix}\nReview guidance: ${latestReviewReason ?? 'No additional guidance provided.'}`,
                        },
                    ],
                });
                const revisionFinishedAt = Date.now();
                const revisionUsage = captureUsage(
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

    const workflowLineage: WorkflowRecord = {
        workflowId,
        workflowName: workflowConfig.workflowName,
        status: workflowStatus,
        stepCount: workflowState.stepCount,
        maxSteps: executionLimits.maxWorkflowSteps,
        maxDurationMs: executionLimits.maxDurationMs,
        terminationReason,
        steps: workflowSteps,
    };

    if (draftResult === null) {
        return {
            outcome: 'no_generation',
            workflowLineage,
        };
    }

    return {
        outcome: 'generated',
        generationResult: draftResult,
        workflowLineage,
    };
};
