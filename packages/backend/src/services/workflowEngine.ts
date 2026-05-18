/**
 * @description: Defines backend-owned workflow engine primitives for step orchestration and bounded execution.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngine
 * @footnote-risk: medium - Incorrect transition or limit logic can cause invalid workflow routes or runaway execution.
 * @footnote-ethics: high - Workflow control determines whether model-deliberative paths remain bounded and auditable.
 */
import type { WorkflowStepKind } from '@footnote/contracts/policy';
import type { WorkflowTerminationReason } from '@footnote/contracts/policy';
import type {
    ContextStepRequest as ContractContextStepRequest,
    ContextStepResult as ContractContextStepResult,
    ExecutionReasonCode,
    ToolExecutionContext,
    StepRecord,
    WorkflowLimitKey,
    WorkflowRecord,
} from '@footnote/contracts/policy';
import type { WorkflowProfilePolicyContract } from './workflowProfileContract.js';
import type {
    GenerationRequest,
    GenerationResult,
    GenerationRuntime,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type { ModelProfile } from '@footnote/contracts';
import { logger } from '../utils/logger.js';
import type {
    PlanContinuationBuilder,
    PlanContinuation,
    PlanTerminalAction,
    PlannerStepExecutor,
    PlannerStepRequest,
    PlannerStepResult,
} from './plannerWorkflowSeams.js';
import type { ConversationContextEnvelope } from './conversationContextService.js';
import {
    sanitizeReviewModuleIds,
    type ReviewModuleId,
} from './reviewModules.js';
import {
    DEFAULT_REVIEW_DECISION_PROMPT,
    DEFAULT_REVISION_PROMPT_PREFIX,
    parseReviewDecisionOutput,
    type ReviewDecision,
} from './workflowEngine/reviewDecision.js';
import { isWorkflowTransitionAllowed } from './workflowEngine/transitions.js';
import {
    applyStepExecutionToState,
    createInitialWorkflowState,
} from './workflowEngine/state.js';
import {
    resolveExecutionLimits,
    buildExecutionLimitStop,
    checkExecutionLimits,
    mapLimitExhaustionToTerminationReason,
    UNBOUNDED_EXECUTION_LIMIT,
    type ExecutionLimits,
} from './workflowEngine/limits.js';
import { buildPlannerStepRecord } from './workflowEngine/plannerStepRecord.js';
import { executeReviewLoop } from './workflowEngine/reviewLoopExecutor.js';
import {
    injectContextMessagesIntoPrompt,
    selectContextStepExecutor,
    selectFollowUpSearchHint,
} from './workflowEngine/contextStepHelpers.js';
import { executeStepRoutingChain } from './stepRoutingExecutor.js';
import type { ResolvedStepRoutingCandidate } from './stepRoutingChains.js';

/**
 * Canonical Execution Contract workflow-policy surface.
 *
 * This alias keeps existing engine call sites stable while making
 * `WorkflowProfilePolicyContract` the single source of truth for shape.
 */
export type WorkflowRunPolicy = WorkflowProfilePolicyContract;

/**
 * Canonical execution-limits surface used by workflow runtime checks.
 */
export type {
    ExecutionLimits,
    ExhaustedExecutionLimit,
} from './workflowEngine/limits.js';
export type { WorkflowState } from './workflowEngine/state.js';
export type { ReviewDecision } from './workflowEngine/reviewDecision.js';
export {
    DEFAULT_REVIEW_DECISION_PROMPT,
    DEFAULT_REVISION_PROMPT_PREFIX,
    parseReviewDecisionOutput,
} from './workflowEngine/reviewDecision.js';

export type BoundedReviewProfileStrategy = {
    reviewDecisionPrompt: string;
    revisionPromptPrefix: string;
    parseReviewDecision: (text: string) => ReviewDecision | null;
};

export const BOUNDED_REVIEW_PROFILE_STRATEGY: BoundedReviewProfileStrategy = {
    reviewDecisionPrompt: DEFAULT_REVIEW_DECISION_PROMPT,
    revisionPromptPrefix: DEFAULT_REVISION_PROMPT_PREFIX,
    parseReviewDecision: parseReviewDecisionOutput,
};

export type ReviewWorkflowRuntimeConfig = {
    workflowName: string;
    maxIterations: number;
    maxDurationMs: number;
    executionLimits?: ExecutionLimits;
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
    contextEnvelope: ConversationContextEnvelope;
    generationStartedAtMs: number;
    workflowConfig: ReviewWorkflowRuntimeConfig;
    workflowPolicy: WorkflowRunPolicy;
    profileStrategy?: BoundedReviewProfileStrategy;
    reviewDecisionPrompt?: string;
    revisionPromptPrefix?: string;
    reviewModuleIds?: ReviewModuleId[];
    parseReviewDecision?: (text: string) => ReviewDecision | null;
    captureUsage: (
        result: GenerationResult,
        requestedModel: string | undefined
    ) => ReviewWorkflowUsageSummary;
    plannerStepRecord?: StepRecord;
    // Workflow engine owns when the plan step runs.
    plannerStepRequest?: PlannerStepRequest;
    plannerStepExecutor?: PlannerStepExecutor;
    // Caller-owned policy application. Engine only consumes continuation output.
    planContinuationBuilder?: PlanContinuationBuilder;
    // Multi-integration input. Engine executes eligible steps in parallel.
    contextStepRequests?: ContextStepRequest[];
    contextStepExecutor?: ContextStepExecutor;
    // Preferred executor routing by integration name.
    contextStepExecutorRegistry?: Record<string, ContextStepExecutor>;
    // Optional OpenAI-native follow-up search from context-step search hints.
    openAiNativeSearchFromHintsEnabled?: boolean;
    stepRoutingChainSet?: {
        enabledProfilesById: Map<string, ModelProfile>;
        generateCandidates: ResolvedStepRoutingCandidate[];
        assessCandidates: ResolvedStepRoutingCandidate[];
    };
};

export type RunBoundedReviewWorkflowResult =
    | {
          outcome: 'generated';
          generationResult: GenerationResult;
          workflowLineage: WorkflowRecord;
          plannerStepResult?: PlannerStepResult;
          planContinuation?: PlanContinuation;
          contextStepResult?: ContextStepResult;
          contextStepResults?: ContextStepResult[];
      }
    | {
          outcome: 'terminal_action';
          terminalAction: PlanTerminalAction;
          workflowLineage: WorkflowRecord;
          plannerStepResult?: PlannerStepResult;
          planContinuation?: PlanContinuation;
          contextStepResult?: ContextStepResult;
          contextStepResults?: ContextStepResult[];
      }
    | {
          outcome: 'no_generation';
          workflowLineage: WorkflowRecord;
          plannerStepResult?: PlannerStepResult;
          planContinuation?: PlanContinuation;
          contextStepResult?: ContextStepResult;
          contextStepResults?: ContextStepResult[];
      };

export type ContextStepRequest = ContractContextStepRequest;

export type ContextStepResult = ContractContextStepResult;

export type ContextStepExecutorInput = {
    request: ContextStepRequest;
    workflowId: string;
    workflowName: string;
    attempt: number;
};

export type ContextStepExecutor = (
    input: ContextStepExecutorInput
) => Promise<ContextStepResult>;

type ContextStepExecutionOutcome = {
    request: ContextStepRequest;
    result?: ContextStepResult;
    error?: unknown;
    blockedByLimit?: boolean;
    startedAtMs: number;
    finishedAtMs: number;
};

type LimitStopEvaluation = {
    stopped: boolean;
    shouldStop: boolean;
    terminationReason: WorkflowTerminationReason;
    workflowStatus: WorkflowRecord['status'];
    exhaustedLimitKey?: WorkflowLimitKey;
};
export { isWorkflowTransitionAllowed } from './workflowEngine/transitions.js';
export {
    applyStepExecutionToState,
    cloneWorkflowState,
    createInitialWorkflowState,
} from './workflowEngine/state.js';
export {
    checkExecutionLimits,
    mapLimitExhaustionToTerminationReason,
} from './workflowEngine/limits.js';
export { buildPlannerStepRecord } from './workflowEngine/plannerStepRecord.js';
export type { BuildPlannerStepRecordInput } from './workflowEngine/plannerStepRecord.js';

export const runBoundedReviewWorkflow = async ({
    generationRuntime,
    generationRequest,
    messagesWithHints,
    contextEnvelope,
    generationStartedAtMs,
    workflowConfig,
    workflowPolicy,
    profileStrategy = BOUNDED_REVIEW_PROFILE_STRATEGY,
    reviewDecisionPrompt,
    revisionPromptPrefix,
    reviewModuleIds,
    parseReviewDecision,
    captureUsage,
    plannerStepRecord,
    plannerStepRequest,
    plannerStepExecutor,
    planContinuationBuilder,
    contextStepRequests,
    contextStepExecutor,
    contextStepExecutorRegistry,
    openAiNativeSearchFromHintsEnabled = false,
    stepRoutingChainSet,
}: RunBoundedReviewWorkflowInput): Promise<RunBoundedReviewWorkflowResult> => {
    if (!contextEnvelope) {
        throw new Error(
            'contextEnvelope is required for runBoundedReviewWorkflow.'
        );
    }
    // NOTE: Concrete tool execution is still orchestrator/registry-owned.
    // This engine path currently executes only Reviewed generation steps.
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
    let plannerRootStepId: string | undefined;
    if (plannerStepRecord?.stepKind === 'plan') {
        workflowSteps.push(plannerStepRecord);
        stepCounter = 1;
        plannerRootStepId = plannerStepRecord.stepId;
    }
    let plannerExecutionResult: PlannerStepResult | undefined;
    let terminationReason: WorkflowTerminationReason = 'budget_exhausted_steps';
    let workflowStatus: WorkflowRecord['status'] = 'degraded';
    let draftResult: GenerationResult | null = null;
    let draftParentStepId: string | undefined;
    let shouldStop = false;
    let exhaustedLimitKey: WorkflowLimitKey | undefined;
    let executedContextStepResult: ContextStepResult | undefined;
    let executedContextStepResults: ContextStepResult[] = [];
    let messagesWithContext = messagesWithHints;
    let effectiveGenerationRequest = generationRequest;
    let effectiveMessagesWithHints = messagesWithHints;
    let effectiveContextEnvelope: ConversationContextEnvelope = contextEnvelope;
    let effectiveContextStepRequests = contextStepRequests;
    let workflowTerminalAction: PlanTerminalAction | undefined;
    let planContinuation: PlanContinuation | undefined;
    const effectiveReviewDecisionPrompt = reviewDecisionPrompt?.trim();
    const effectiveRevisionPromptPrefix =
        revisionPromptPrefix ?? profileStrategy.revisionPromptPrefix;
    const effectiveParseReviewDecision =
        parseReviewDecision ?? profileStrategy.parseReviewDecision;
    const selectedReviewModuleIds = sanitizeReviewModuleIds(reviewModuleIds);

    const executionLimits: ExecutionLimits = {
        maxWorkflowSteps: sanitizePositiveInteger(
            workflowConfig.executionLimits?.maxWorkflowSteps ??
                Math.max(1, normalizedMaxIterations * 2),
            Math.max(1, normalizedMaxIterations * 2)
        ),
        maxToolCalls: sanitizeNonNegativeInteger(
            workflowConfig.executionLimits?.maxToolCalls ??
                UNBOUNDED_EXECUTION_LIMIT,
            UNBOUNDED_EXECUTION_LIMIT
        ),
        maxPlanCycles: sanitizeNonNegativeInteger(
            workflowConfig.executionLimits?.maxPlanCycles ?? 1,
            1
        ),
        maxReviewCycles: sanitizeNonNegativeInteger(
            workflowConfig.executionLimits?.maxReviewCycles ??
                Math.max(0, normalizedMaxIterations * 2 - 1),
            Math.max(0, normalizedMaxIterations * 2 - 1)
        ),
        maxDeliberationCalls: sanitizeNonNegativeInteger(
            workflowConfig.executionLimits?.maxDeliberationCalls ??
                Math.max(1, normalizedMaxIterations * 2),
            Math.max(1, normalizedMaxIterations * 2)
        ),
        maxTokensTotal: sanitizeNonNegativeInteger(
            workflowConfig.executionLimits?.maxTokensTotal ??
                UNBOUNDED_EXECUTION_LIMIT,
            UNBOUNDED_EXECUTION_LIMIT
        ),
        maxDurationMs: sanitizePositiveInteger(
            workflowConfig.executionLimits?.maxDurationMs ??
                normalizedMaxDurationMs,
            normalizedMaxDurationMs
        ),
    };
    const hasExplicitMaxDeliberationCalls =
        workflowConfig.executionLimits?.maxDeliberationCalls !== undefined;
    if (!hasExplicitMaxDeliberationCalls) {
        executionLimits.maxDeliberationCalls = Math.max(
            executionLimits.maxDeliberationCalls,
            (executionLimits.maxPlanCycles ?? 0) +
                (executionLimits.maxReviewCycles ?? 0)
        );
    }
    const effectiveMaxIterations =
        workflowConfig.executionLimits !== undefined
            ? Math.max(
                  0,
                  Math.min(
                      Math.ceil(executionLimits.maxDeliberationCalls / 2),
                      Math.ceil(
                          Math.max(0, executionLimits.maxWorkflowSteps - 1) / 2
                      )
                  )
              )
            : normalizedMaxIterations;
    let workflowState = createInitialWorkflowState({
        workflowId,
        workflowName: workflowConfig.workflowName,
        startedAtMs: workflowStartedAt,
    });

    if (plannerStepRecord?.stepKind === 'plan') {
        workflowState = {
            ...workflowState,
            stepCount: workflowState.stepCount + 1,
            planCallCount: workflowState.planCallCount + 1,
        };
    }

    const captureStep = (input: {
        stepKind: StepRecord['stepKind'];
        status: StepRecord['outcome']['status'];
        summary: string;
        artifacts?: string[];
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
                ...(input.artifacts !== undefined && {
                    artifacts: input.artifacts,
                }),
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

    const stopIfOverLimits = (
        nextStepKind?: WorkflowStepKind
    ): LimitStopEvaluation => {
        const limitsCheck = checkExecutionLimits(
            workflowState,
            executionLimits,
            Date.now(),
            nextStepKind
        );
        if (limitsCheck.withinLimits) {
            return {
                stopped: false,
                shouldStop,
                terminationReason,
                workflowStatus,
                exhaustedLimitKey,
            };
        }

        exhaustedLimitKey = limitsCheck.exhaustedBy;
        terminationReason =
            exhaustedLimitKey !== undefined
                ? mapLimitExhaustionToTerminationReason(exhaustedLimitKey)
                : 'budget_exhausted_steps';
        workflowStatus = 'degraded';
        shouldStop = true;
        return {
            stopped: true,
            shouldStop,
            terminationReason,
            workflowStatus,
            exhaustedLimitKey,
        };
    };

    if (
        plannerRootStepId === undefined &&
        plannerStepRequest !== undefined &&
        plannerStepExecutor !== undefined
    ) {
        if (
            !isWorkflowTransitionAllowed(
                workflowState.currentStepKind,
                'plan',
                workflowPolicy
            )
        ) {
            terminationReason = 'transition_blocked_by_policy';
            shouldStop = true;
        } else if (!stopIfOverLimits('plan').stopped) {
            const plannerStartedAt = Date.now();
            plannerExecutionResult = await plannerStepExecutor({
                ...plannerStepRequest,
                workflowId,
                workflowName: workflowConfig.workflowName,
                attempt: 1,
            });
            const plannerFinishedAt = Date.now();
            const plannerStep = buildPlannerStepRecord({
                stepId: 'step_1',
                attempt: 1,
                startedAtMs: plannerStartedAt,
                finishedAtMs: plannerFinishedAt,
                summary: {
                    status: plannerExecutionResult.execution.status,
                    ...(plannerExecutionResult.execution.reasonCode !==
                        undefined && {
                        reasonCode: plannerExecutionResult.execution.reasonCode,
                    }),
                    purpose: plannerExecutionResult.execution.purpose,
                    contractType: plannerExecutionResult.execution.contractType,
                    applyOutcome:
                        plannerExecutionResult.execution.status === 'executed'
                            ? 'applied'
                            : 'not_applied',
                    durationMs: plannerExecutionResult.execution.durationMs,
                    action: plannerExecutionResult.plan.action,
                    modality: plannerExecutionResult.plan.modality,
                    requestedCapabilityProfile:
                        plannerExecutionResult.plan.requestedCapabilityProfile,
                    ...(plannerExecutionResult.execution
                        .routingChainAttempts !== undefined && {
                        routingChainAttempts:
                            plannerExecutionResult.execution
                                .routingChainAttempts,
                    }),
                },
            });
            workflowSteps.push(plannerStep);
            stepCounter = 1;
            plannerRootStepId = plannerStep.stepId;
            workflowState = applyStepExecutionToState(
                workflowState,
                'plan',
                0,
                0,
                1
            );
        }
    }

    if (
        plannerExecutionResult !== undefined &&
        planContinuationBuilder !== undefined
    ) {
        try {
            planContinuation = planContinuationBuilder({
                plannerStepResult: plannerExecutionResult,
                workflowId,
                workflowName: workflowConfig.workflowName,
                attempt: 1,
                baseMessagesWithHints: messagesWithHints,
                baseGenerationRequest: generationRequest,
                contextEnvelope: effectiveContextEnvelope,
            });
            if (planContinuation.continuation === 'terminal_action') {
                workflowTerminalAction = planContinuation.terminalAction;
            } else {
                effectiveGenerationRequest = planContinuation.generationRequest;
                effectiveMessagesWithHints = planContinuation.messagesWithHints;
                effectiveContextStepRequests =
                    planContinuation.contextStepRequests ??
                    effectiveContextStepRequests;
            }
        } catch (error) {
            logger.warn(
                'Plan continuation builder failed; continuing with pre-plan generation request.',
                {
                    workflowId,
                    workflowName: workflowConfig.workflowName,
                    attempt: 1,
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
        }
    }

    if (workflowTerminalAction !== undefined) {
        const terminalStartedAt = Date.now();
        const terminalFinishedAt = Date.now();
        captureStep({
            stepKind: 'finalize',
            status: 'executed',
            summary:
                workflowTerminalAction.responseAction === 'image'
                    ? 'Workflow completed with planner terminal image action.'
                    : workflowTerminalAction.responseAction === 'react'
                      ? 'Workflow completed with planner terminal reaction action.'
                      : 'Workflow completed with planner terminal ignore action.',
            startedAtMs: terminalStartedAt,
            finishedAtMs: terminalFinishedAt,
            parentStepId: plannerRootStepId,
            attempt: 1,
            signals: {
                terminalAction: workflowTerminalAction.responseAction,
            },
        });
        workflowState = applyStepExecutionToState(
            workflowState,
            'finalize',
            0,
            0,
            0
        );
        terminationReason = 'goal_satisfied';
        workflowStatus = 'completed';
        shouldStop = true;
    }

    const requestedContextSteps = (effectiveContextStepRequests ?? []).filter(
        (request) => request.requested === true && request.eligible
    );
    const executableContextSteps = requestedContextSteps.filter(
        (request) =>
            selectContextStepExecutor(
                request,
                contextStepExecutor,
                contextStepExecutorRegistry
            ) !== undefined
    );
    if (!shouldStop && executableContextSteps.length > 0) {
        if (
            !isWorkflowTransitionAllowed(
                workflowState.currentStepKind,
                'tool',
                workflowPolicy
            )
        ) {
            terminationReason = 'transition_blocked_by_policy';
            shouldStop = true;
        } else if (!stopIfOverLimits('tool').stopped) {
            // Parallel execution keeps integration latency bounded while each
            // outcome remains independently fail-open and lineage-recorded.
            const remainingToolCalls =
                executionLimits.maxToolCalls === UNBOUNDED_EXECUTION_LIMIT
                    ? Number.POSITIVE_INFINITY
                    : Math.max(
                          0,
                          executionLimits.maxToolCalls -
                              workflowState.toolCallCount
                      );
            let reservedToolCallCount = 0;
            const contextStepOutcomes = await Promise.all(
                executableContextSteps.map(
                    async (request): Promise<ContextStepExecutionOutcome> => {
                        if (reservedToolCallCount >= remainingToolCalls) {
                            const blockedAtMs = Date.now();
                            return {
                                request,
                                blockedByLimit: true,
                                startedAtMs: blockedAtMs,
                                finishedAtMs: blockedAtMs,
                            };
                        }
                        reservedToolCallCount += 1;
                        const executor = selectContextStepExecutor(
                            request,
                            contextStepExecutor,
                            contextStepExecutorRegistry
                        );
                        if (executor === undefined) {
                            return {
                                request,
                                startedAtMs: Date.now(),
                                finishedAtMs: Date.now(),
                            };
                        }
                        const startedAtMs = Date.now();
                        try {
                            const result = await executor({
                                request,
                                workflowId,
                                workflowName: workflowConfig.workflowName,
                                attempt: 1,
                            });
                            return {
                                request,
                                result,
                                startedAtMs,
                                finishedAtMs: Date.now(),
                            };
                        } catch (error) {
                            return {
                                request,
                                error,
                                startedAtMs,
                                finishedAtMs: Date.now(),
                            };
                        }
                    }
                )
            );
            for (const contextStepOutcome of contextStepOutcomes) {
                if (contextStepOutcome.blockedByLimit === true) {
                    exhaustedLimitKey = 'maxToolCalls';
                    terminationReason =
                        mapLimitExhaustionToTerminationReason('maxToolCalls');
                    workflowStatus = 'degraded';
                    shouldStop = true;
                    continue;
                }
                if (contextStepOutcome.error !== undefined) {
                    logger.error(
                        'Context step execution failed; workflow continued fail-open without context.',
                        {
                            stepKind: 'tool',
                            reasonCode: 'tool_execution_error',
                            startedAtMs: contextStepOutcome.startedAtMs,
                            finishedAtMs: contextStepOutcome.finishedAtMs,
                            parentStepId: plannerRootStepId,
                            attempt: 1,
                            workflowName: workflowConfig.workflowName,
                            workflowId,
                            integrationName:
                                contextStepOutcome.request.integrationName,
                            error:
                                contextStepOutcome.error instanceof Error
                                    ? contextStepOutcome.error.message
                                    : String(contextStepOutcome.error),
                        }
                    );
                    captureStep({
                        stepKind: 'tool',
                        status: 'failed',
                        summary:
                            'Context step execution failed; workflow continued fail-open without context.',
                        reasonCode: 'tool_execution_error',
                        startedAtMs: contextStepOutcome.startedAtMs,
                        finishedAtMs: contextStepOutcome.finishedAtMs,
                        parentStepId: plannerRootStepId,
                        attempt: 1,
                    });
                    workflowState = applyStepExecutionToState(
                        workflowState,
                        'tool',
                        0,
                        1,
                        0
                    );
                    continue;
                }
                if (contextStepOutcome.result === undefined) {
                    continue;
                }
                const normalizedExecutionContext: ToolExecutionContext = {
                    ...contextStepOutcome.result.executionContext,
                    toolName:
                        contextStepOutcome.result.executionContext.toolName,
                    ...(contextStepOutcome.result.executionContext
                        .clarification === undefined &&
                        contextStepOutcome.result.clarification !==
                            undefined && {
                            clarification:
                                contextStepOutcome.result.clarification,
                        }),
                };
                const normalizedResult: ContextStepResult = {
                    executionContext: normalizedExecutionContext,
                    ...(contextStepOutcome.result.contextMessages !==
                        undefined && {
                        contextMessages:
                            contextStepOutcome.result.contextMessages,
                    }),
                    ...(normalizedExecutionContext.clarification !==
                        undefined && {
                        clarification: normalizedExecutionContext.clarification,
                    }),
                    ...(contextStepOutcome.result.sources !== undefined && {
                        sources: contextStepOutcome.result.sources,
                    }),
                    ...(contextStepOutcome.result.integrationContext !==
                        undefined && {
                        integrationContext:
                            contextStepOutcome.result.integrationContext,
                    }),
                };
                executedContextStepResults.push(normalizedResult);
                const status =
                    normalizedExecutionContext.status === 'failed'
                        ? 'failed'
                        : 'executed';
                captureStep({
                    stepKind: 'tool',
                    status,
                    summary:
                        status === 'failed'
                            ? 'Context step failed; workflow continued fail-open without context.'
                            : normalizedExecutionContext.clarification !==
                                undefined
                              ? 'Context step requires user clarification before generation.'
                              : 'Context step executed and emitted bounded context messages.',
                    ...(normalizedExecutionContext.reasonCode !== undefined && {
                        reasonCode: normalizedExecutionContext.reasonCode,
                    }),
                    startedAtMs: contextStepOutcome.startedAtMs,
                    finishedAtMs: contextStepOutcome.finishedAtMs,
                    parentStepId: plannerRootStepId,
                    attempt: 1,
                    ...(normalizedResult.contextMessages !== undefined && {
                        artifacts: normalizedResult.contextMessages,
                    }),
                    ...(normalizedExecutionContext.clarification !==
                        undefined && {
                        signals: {
                            clarificationReasonCode:
                                normalizedExecutionContext.clarification
                                    .reasonCode,
                            clarificationOptionCount:
                                normalizedExecutionContext.clarification.options
                                    .length,
                        },
                    }),
                });
                workflowState = applyStepExecutionToState(
                    workflowState,
                    'tool',
                    0,
                    1,
                    0
                );
                if (normalizedExecutionContext.clarification !== undefined) {
                    terminationReason = 'goal_satisfied';
                    workflowStatus = 'completed';
                    shouldStop = true;
                }
            }
            executedContextStepResult = executedContextStepResults.at(0);
        }
    }

    if (!shouldStop) {
        if (
            !isWorkflowTransitionAllowed(
                workflowState.currentStepKind,
                'generate',
                workflowPolicy
            )
        ) {
            terminationReason = 'transition_blocked_by_policy';
            shouldStop = true;
        } else if (!stopIfOverLimits('generate').stopped) {
            const initialDraftStartedAt = generationStartedAtMs;
            messagesWithContext = injectContextMessagesIntoPrompt(
                effectiveMessagesWithHints,
                // Preserve deterministic context ordering by request list order.
                executedContextStepResults.flatMap(
                    (contextStepResult) =>
                        contextStepResult.contextMessages ?? []
                )
            );
            const selectedFollowUpSearchHint = selectFollowUpSearchHint({
                results: executedContextStepResults,
                openAiNativeSearchFromHintsEnabled,
                effectiveGenerationRequest,
            });
            try {
                let initialRoutingChainAttempts:
                    | Array<{
                          index: number;
                          step: string;
                          profileId: string;
                          provider?: string;
                          model?: string;
                          status: string;
                          reasonCode?: string;
                          chooseOneUsed: boolean;
                          chooseOneCandidates?: string[];
                          chooseOneSelectedIndex?: number;
                          seedKeyType?: 'session_id' | 'correlation_id';
                      }>
                    | undefined;
                let initialRoutedProfile:
                    | {
                          profileId: string;
                          provider: string;
                          model: string;
                      }
                    | undefined;
                const generationRequestForAttempt: GenerationRequest = {
                    ...effectiveGenerationRequest,
                    messages: messagesWithContext,
                    ...(selectedFollowUpSearchHint !== undefined &&
                        effectiveGenerationRequest.search === undefined && {
                            search: {
                                query: selectedFollowUpSearchHint.query,
                                intent: selectedFollowUpSearchHint.intent,
                                contextSize: 'low',
                            },
                        }),
                };
                if (
                    stepRoutingChainSet?.generateCandidates &&
                    stepRoutingChainSet.generateCandidates.length > 0
                ) {
                    const chainResult = await executeStepRoutingChain({
                        step: 'generate',
                        candidates: stepRoutingChainSet.generateCandidates,
                        enabledProfilesById:
                            stepRoutingChainSet.enabledProfilesById,
                        requiresSearch:
                            generationRequestForAttempt.search !== undefined,
                        runWithProfile: async (profile) =>
                            generationRuntime.generate({
                                ...generationRequestForAttempt,
                                model: profile.providerModel,
                                provider: profile.provider,
                                capabilities: profile.capabilities,
                            }),
                    });
                    if (chainResult.status !== 'executed') {
                        throw new Error(chainResult.reasonCode);
                    }
                    initialRoutingChainAttempts = chainResult.attempts;
                    initialRoutedProfile = {
                        profileId: chainResult.selected.profile.id,
                        provider: chainResult.selected.profile.provider,
                        model: chainResult.selected.profile.providerModel,
                    };
                    draftResult = chainResult.value;
                } else {
                    draftResult = await generationRuntime.generate(
                        generationRequestForAttempt
                    );
                }
                const initialDraftFinishedAt = Date.now();
                const initialDraftUsage = captureUsage(
                    draftResult,
                    effectiveGenerationRequest.model
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
                    parentStepId: plannerRootStepId,
                    attempt: 1,
                    ...(initialRoutingChainAttempts !== undefined && {
                        signals: {
                            routingChainAttemptCount:
                                initialRoutingChainAttempts.length,
                            routingChainAttemptsJson: JSON.stringify(
                                initialRoutingChainAttempts
                            ),
                            ...(initialRoutedProfile !== undefined && {
                                routedProfileId: initialRoutedProfile.profileId,
                                routedProvider: initialRoutedProfile.provider,
                                routedModel: initialRoutedProfile.model,
                            }),
                        },
                    }),
                });
                draftParentStepId = initialDraftStepId;
                workflowState = applyStepExecutionToState(
                    workflowState,
                    'generate',
                    initialDraftUsage.totalTokens,
                    0,
                    0
                );
            } catch (error) {
                const initialDraftFinishedAt = Date.now();
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const reasonCode: ExecutionReasonCode =
                    errorMessage === 'routing_chain_exhausted' ||
                    errorMessage === 'routing_chain_non_transient_error'
                        ? (errorMessage as ExecutionReasonCode)
                        : 'generation_runtime_error';
                logger.error(
                    'Initial workflow generation failed; returning classified no-generation outcome.',
                    {
                        stepKind: 'generate',
                        reasonCode,
                        startedAtMs: initialDraftStartedAt,
                        finishedAtMs: initialDraftFinishedAt,
                        workflowName: workflowState.workflowName,
                        workflowId: workflowState.workflowId,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    }
                );
                captureStep({
                    stepKind: 'generate',
                    status: 'failed',
                    summary:
                        'Initial generation failed; workflow returned classified no-generation outcome.',
                    reasonCode,
                    startedAtMs: initialDraftStartedAt,
                    finishedAtMs: initialDraftFinishedAt,
                    parentStepId: plannerRootStepId,
                    attempt: 1,
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
        }
    }
    if (!shouldStop && effectiveMaxIterations === 0) {
        terminationReason = 'goal_satisfied';
        workflowStatus = 'completed';
    }

    const reviewLoopResult = await executeReviewLoop({
        effectiveMaxIterations,
        workflowPolicy,
        stopIfOverLimits,
        selectedReviewModuleIds,
        effectiveReviewDecisionPrompt,
        generationRuntime,
        messagesWithContext,
        draftResult,
        effectiveGenerationRequest,
        captureUsage,
        effectiveParseReviewDecision,
        captureStep,
        draftParentStepId,
        terminationReason,
        workflowStatus,
        shouldStop,
        workflowState,
        exhaustedLimitKey,
        plannerStepRequest,
        plannerStepExecutor,
        planContinuationBuilder,
        workflowId,
        workflowName: workflowConfig.workflowName,
        effectiveMessagesWithHints,
        effectiveContextEnvelope,
        effectiveRevisionPromptPrefix,
        stepCounterRef: { value: stepCounter },
        workflowStepsRef: { value: workflowSteps },
        planContinuation,
        stepRoutingChainSet,
    });
    stepCounter = reviewLoopResult.stepCounter;
    draftResult = reviewLoopResult.draftResult;
    terminationReason = reviewLoopResult.terminationReason;
    workflowStatus = reviewLoopResult.workflowStatus;
    workflowState = reviewLoopResult.workflowState;
    exhaustedLimitKey = reviewLoopResult.exhaustedLimitKey;
    planContinuation = reviewLoopResult.planContinuation;

    const workflowLineage: WorkflowRecord = {
        workflowId,
        workflowName: workflowConfig.workflowName,
        status: workflowStatus,
        stepCount: workflowSteps.length,
        maxSteps: executionLimits.maxWorkflowSteps,
        maxDurationMs: executionLimits.maxDurationMs,
        effectiveLimits: resolveExecutionLimits({
            limits: executionLimits,
            policy: workflowPolicy,
            exhaustedLimitKey,
        }),
        limitStop: buildExecutionLimitStop({
            terminationReason,
            exhaustedLimitKey,
        }),
        terminationReason,
        steps: workflowSteps,
    };

    if (workflowTerminalAction !== undefined) {
        return {
            outcome: 'terminal_action',
            terminalAction: workflowTerminalAction,
            workflowLineage,
            ...(plannerExecutionResult !== undefined && {
                plannerStepResult: plannerExecutionResult,
            }),
            ...(planContinuation !== undefined && {
                planContinuation,
            }),
            ...(executedContextStepResult !== undefined && {
                contextStepResult: executedContextStepResult,
            }),
            ...(executedContextStepResults.length > 0 && {
                contextStepResults: executedContextStepResults,
            }),
        };
    }

    if (draftResult === null) {
        return {
            outcome: 'no_generation',
            workflowLineage,
            ...(plannerExecutionResult !== undefined && {
                plannerStepResult: plannerExecutionResult,
            }),
            ...(planContinuation !== undefined && {
                planContinuation,
            }),
            ...(executedContextStepResult !== undefined && {
                contextStepResult: executedContextStepResult,
            }),
            ...(executedContextStepResults.length > 0 && {
                contextStepResults: executedContextStepResults,
            }),
        };
    }

    return {
        outcome: 'generated',
        generationResult: draftResult,
        workflowLineage,
        ...(plannerExecutionResult !== undefined && {
            plannerStepResult: plannerExecutionResult,
        }),
        ...(planContinuation !== undefined && {
            planContinuation,
        }),
        ...(executedContextStepResult !== undefined && {
            contextStepResult: executedContextStepResult,
        }),
        ...(executedContextStepResults.length > 0 && {
            contextStepResults: executedContextStepResults,
        }),
    };
};
