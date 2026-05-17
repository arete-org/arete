/**
 * @description: Centralizes workflow execution-limit checks and limit metadata
 * serialization for lineage.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineLimits
 * @footnote-risk: medium - Limit bugs can cause runaway loops or premature stops.
 * @footnote-ethics: high - Bound enforcement is core to safe deliberation control.
 */
import type {
    WorkflowEffectiveLimit,
    WorkflowLimitKey,
    WorkflowLimitStop,
    WorkflowTerminationReason,
    WorkflowStepKind,
} from '@footnote/contracts/policy';
import type { WorkflowProfileExecutionLimitsContract } from '../workflowProfileContract.js';
import type { WorkflowProfilePolicyContract } from '../workflowProfileContract.js';
import type { WorkflowState } from './state.js';

export type ExecutionLimits = WorkflowProfileExecutionLimitsContract;
export type ExhaustedExecutionLimit = WorkflowLimitKey;

export const mapLimitExhaustionToTerminationReason = (
    exhaustedBy: ExhaustedExecutionLimit
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

export const checkExecutionLimits = (
    state: WorkflowState,
    limits: ExecutionLimits,
    nowMs: number,
    nextStepKind?: WorkflowStepKind
): {
    withinLimits: boolean;
    exhaustedBy?: ExhaustedExecutionLimit;
} => {
    if (state.stepCount >= limits.maxWorkflowSteps) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxWorkflowSteps',
        };
    }

    const isNextStepTool = nextStepKind === 'tool';
    if (isNextStepTool && state.toolCallCount >= limits.maxToolCalls) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxToolCalls',
        };
    }

    const isNextStepDeliberative =
        nextStepKind === 'plan' || nextStepKind === 'assess';
    const maxPlanCycles =
        limits.maxPlanCycles ?? Math.max(0, limits.maxDeliberationCalls);
    const maxReviewCycles =
        limits.maxReviewCycles ??
        Math.max(0, limits.maxDeliberationCalls - maxPlanCycles);
    if (nextStepKind === 'plan' && state.planCallCount >= maxPlanCycles) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxDeliberationCalls',
        };
    }
    if (nextStepKind === 'assess' && state.reviewCallCount >= maxReviewCycles) {
        return {
            withinLimits: false,
            exhaustedBy: 'maxDeliberationCalls',
        };
    }
    if (
        isNextStepDeliberative &&
        state.deliberationCallCount >= limits.maxDeliberationCalls
    ) {
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

const UNBOUNDED_EXECUTION_LIMIT_SENTINEL = Number.MAX_SAFE_INTEGER;

const isUnavailableExecutionLimit = (value: number): boolean =>
    !Number.isFinite(value) || value >= UNBOUNDED_EXECUTION_LIMIT_SENTINEL;

const isExecutionLimitPathActive = (
    key: WorkflowLimitKey,
    policy: WorkflowProfilePolicyContract
): boolean => {
    if (key === 'maxToolCalls') {
        return policy.enableToolUse;
    }

    if (key === 'maxDeliberationCalls') {
        return (
            policy.enablePlanning ||
            policy.enableAssessment ||
            policy.enableRevision
        );
    }

    return true;
};

export const resolveExecutionLimits = (input: {
    limits: ExecutionLimits;
    policy: WorkflowProfilePolicyContract;
    exhaustedLimitKey?: WorkflowLimitKey;
}): WorkflowEffectiveLimit[] => {
    const orderedKeys: WorkflowLimitKey[] = [
        'maxWorkflowSteps',
        'maxToolCalls',
        'maxDeliberationCalls',
        'maxTokensTotal',
        'maxDurationMs',
    ];

    return orderedKeys.map((key) => {
        const value = input.limits[key];
        const limitAvailable = !isUnavailableExecutionLimit(value);
        const pathActive = isExecutionLimitPathActive(key, input.policy);
        const state = !limitAvailable
            ? 'unavailable'
            : !pathActive
              ? 'configured_inactive'
              : 'enforced';

        return {
            key,
            state,
            ...(limitAvailable && { value }),
            stoppedRun: input.exhaustedLimitKey === key,
        };
    });
};

export const buildExecutionLimitStop = (input: {
    terminationReason: WorkflowTerminationReason;
    exhaustedLimitKey?: WorkflowLimitKey;
}): WorkflowLimitStop => ({
    stoppedByLimit: input.exhaustedLimitKey !== undefined,
    terminationReason: input.terminationReason,
    ...(input.exhaustedLimitKey !== undefined && {
        exhaustedLimitKey: input.exhaustedLimitKey,
    }),
});

export const UNBOUNDED_EXECUTION_LIMIT = UNBOUNDED_EXECUTION_LIMIT_SENTINEL;
