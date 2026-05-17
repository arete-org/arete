/**
 * @description: Owns workflow step-transition legality checks under profile
 * policy gates.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineTransitions
 * @footnote-risk: medium - Transition bugs can route workflow into invalid paths.
 * @footnote-ethics: high - Transition controls enforce bounded deliberation safety.
 */
import type { WorkflowStepKind } from '@footnote/contracts/policy';
import type { WorkflowProfilePolicyContract } from '../workflowProfileContract.js';

const LEGAL_TRANSITIONS: Record<
    WorkflowStepKind,
    ReadonlySet<WorkflowStepKind>
> = {
    plan: new Set(['tool', 'generate', 'assess', 'finalize']),
    tool: new Set(['tool', 'generate', 'assess', 'finalize']),
    generate: new Set(['assess', 'finalize']),
    assess: new Set(['plan', 'tool', 'generate', 'finalize']),
    revise: new Set(['assess', 'generate', 'finalize']),
    finalize: new Set([]),
};

const isStepKindAllowedByPolicy = (
    stepKind: WorkflowStepKind,
    policy: WorkflowProfilePolicyContract
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

export const isWorkflowTransitionAllowed = (
    fromStepKind: WorkflowStepKind | null,
    toStepKind: WorkflowStepKind,
    policy: WorkflowProfilePolicyContract
): boolean => {
    if (!isStepKindAllowedByPolicy(toStepKind, policy)) {
        return false;
    }

    if (fromStepKind === null) {
        return (
            toStepKind === 'plan' ||
            toStepKind === 'tool' ||
            toStepKind === 'generate'
        );
    }

    if (fromStepKind === 'plan' && toStepKind === 'plan') {
        return policy.enableReplanning;
    }

    return LEGAL_TRANSITIONS[fromStepKind].has(toStepKind);
};
