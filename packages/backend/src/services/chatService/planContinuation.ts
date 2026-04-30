/**
 * @description: Classifies policy-applied planner actions into either a
 * terminal transport response or message-continuation workflow execution.
 * @footnote-scope: core
 * @footnote-module: ChatServicePlanContinuation
 * @footnote-risk: medium - Incorrect classification can skip generation or return wrong action types.
 * @footnote-ethics: medium - Action routing affects user-visible behavior and trust.
 */
import type {
    PostChatRequest,
    PostChatResponse,
} from '@footnote/contracts/web';
import type { ChatPlan } from '../chatPlanner.js';
import type { PlannerFallbackReason } from '../plannerFallbackTelemetryRollup.js';
import type { PlanTerminalAction } from '../plannerWorkflowSeams.js';

export type PlannerActionOutcome =
    | {
          kind: 'continue_message';
      }
    | {
          kind: 'terminal_action';
          terminalAction: PlanTerminalAction;
          fallbackReason?: PlannerFallbackReason;
          warningMessage?: string;
      };

export const classifyPlanContinuation = (input: {
    executionPlan: ChatPlan;
    normalizedRequest: PostChatRequest;
}): PlannerActionOutcome => {
    if (input.executionPlan.action === 'ignore') {
        return {
            kind: 'terminal_action',
            terminalAction: {
                responseAction: 'ignore',
            },
        };
    }

    if (input.executionPlan.action === 'react') {
        return {
            kind: 'terminal_action',
            terminalAction: {
                responseAction: 'react',
                reaction: input.executionPlan.reaction ?? '👍',
            },
        };
    }

    if (
        input.executionPlan.action === 'image' &&
        input.executionPlan.imageRequest !== undefined
    ) {
        return {
            kind: 'terminal_action',
            terminalAction: {
                responseAction: 'image',
                imageRequest: input.executionPlan.imageRequest,
            },
        };
    }

    if (
        input.executionPlan.action === 'image' &&
        input.executionPlan.imageRequest === undefined
    ) {
        return {
            kind: 'terminal_action',
            terminalAction: {
                responseAction: 'ignore',
            },
            fallbackReason: 'image_action_missing_image_request',
            warningMessage: `Chat planner returned image without imageRequest; falling back to ignore. surface=${input.normalizedRequest.surface} trigger=${input.normalizedRequest.trigger.kind} latestUserInputLength=${input.normalizedRequest.latestUserInput.length}`,
        };
    }

    return {
        kind: 'continue_message',
    };
};

export const planTerminalActionToResponse = (
    terminalAction: PlanTerminalAction
): Exclude<PostChatResponse, { action: 'message' }> => {
    if (terminalAction.responseAction === 'ignore') {
        return {
            action: 'ignore',
            metadata: null,
        };
    }
    if (terminalAction.responseAction === 'react') {
        return {
            action: 'react',
            reaction: terminalAction.reaction,
            metadata: null,
        };
    }

    return {
        action: 'image',
        imageRequest: terminalAction.imageRequest,
        metadata: null,
    };
};
