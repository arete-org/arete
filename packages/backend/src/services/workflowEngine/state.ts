/**
 * @description: Defines workflow runtime state and deterministic state updates
 * per executed step.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineState
 * @footnote-risk: medium - Counter drift can break limits and lineage accuracy.
 * @footnote-ethics: medium - State correctness supports traceable runtime behavior.
 */
import type { WorkflowStepKind } from '@footnote/contracts/policy';

export type WorkflowState = {
    workflowId: string;
    workflowName: string;
    startedAtMs: number;
    currentStepKind: WorkflowStepKind | null;
    stepCount: number;
    toolCallCount: number;
    planCallCount: number;
    reviewCallCount: number;
    deliberationCallCount: number;
    totalTokens: number;
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
    planCallCount: 0,
    reviewCallCount: 0,
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
        planCallCount: state.planCallCount + (stepKind === 'plan' ? 1 : 0),
        reviewCallCount:
            state.reviewCallCount + (stepKind === 'assess' ? 1 : 0),
        deliberationCallCount:
            state.deliberationCallCount + sanitizedDeliberationCallsExecuted,
        totalTokens: state.totalTokens + sanitizedUsageTokens,
    };
};
