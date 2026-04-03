/**
 * @description: Defines backend-owned workflow engine primitives for step orchestration and bounded execution.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngine
 * @footnote-risk: medium - Incorrect transition or limit logic can cause invalid workflow routes or runaway execution.
 * @footnote-ethics: high - Workflow control determines whether model-deliberative paths remain bounded and auditable.
 */
import type { WorkflowStepKind } from '@footnote/contracts/ethics-core';
import type { WorkflowTerminationReason } from '@footnote/contracts/ethics-core';

export type WorkflowPolicy = {
    enablePlanning: boolean;
    enableToolUse: boolean;
    enableReplanning: boolean;
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
): WorkflowState => ({
    ...state,
    currentStepKind: stepKind,
    stepCount: state.stepCount + 1,
    toolCallCount: state.toolCallCount + toolCallsExecuted,
    deliberationCallCount:
        state.deliberationCallCount + deliberationCallsExecuted,
    totalTokens: state.totalTokens + usageTokens,
});

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

    return 'max_deliberation_calls_reached';
};
