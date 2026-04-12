/**
 * @description: Defines planner invocation boundaries and validation helpers for workflow-owned planner execution.
 * @footnote-scope: core
 * @footnote-module: ChatPlannerInvocation
 * @footnote-risk: medium - Incorrect validation can allow planner invocation outside workflow-owned boundaries.
 * @footnote-ethics: high - Invocation boundaries preserve clear execution authority and prevent hidden control-plane drift.
 */
import type { PostChatRequest } from '@footnote/contracts/web';

/**
 * Planner is a bounded execution helper owned by workflow orchestration.
 * It is execution-relevant, but it is not policy authority, contract
 * authority, or runtime ownership.
 * TODO(workflow-planner-step-lineage): When planner becomes workflow-native,
 * bind this invocation context to first-class workflow step IDs.
 */
export type ChatPlannerInvocationPurpose = 'chat_orchestrator_action_selection';

export type ChatPlannerInvocationContext = {
    owner: 'workflow';
    workflowName: string;
    stepKind: 'plan';
    purpose: ChatPlannerInvocationPurpose;
};

export const isWorkflowOwnedPlannerInvocation = (
    value: unknown
): value is ChatPlannerInvocationContext => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<ChatPlannerInvocationContext>;
    return (
        candidate.owner === 'workflow' &&
        candidate.stepKind === 'plan' &&
        candidate.purpose === 'chat_orchestrator_action_selection' &&
        typeof candidate.workflowName === 'string' &&
        candidate.workflowName.trim().length > 0
    );
};

const readInvocationField = (
    invocationContext: unknown,
    field: 'owner' | 'workflowName' | 'stepKind' | 'purpose'
): unknown => {
    if (!invocationContext || typeof invocationContext !== 'object') {
        return undefined;
    }

    const record = invocationContext as Record<string, unknown>;
    return record[field];
};

export const buildPlannerInvocationRejectionLogMeta = ({
    request,
    invocationContext,
}: {
    request: PostChatRequest;
    invocationContext?: ChatPlannerInvocationContext;
}): Record<string, unknown> => ({
    event: 'chat.planner.invocation_rejected',
    fallbackTo: 'safe_default_plan',
    reasonCode: 'planner_runtime_error',
    surface: request.surface,
    triggerKind: request.trigger.kind,
    invocationOwner: readInvocationField(invocationContext, 'owner'),
    invocationWorkflowName: readInvocationField(
        invocationContext,
        'workflowName'
    ),
    invocationStepKind: readInvocationField(invocationContext, 'stepKind'),
    invocationPurpose: readInvocationField(invocationContext, 'purpose'),
});
