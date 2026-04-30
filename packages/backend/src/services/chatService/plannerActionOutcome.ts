/**
 * @description: Classifies policy-applied planner actions into either a
 * terminal transport response or message-continuation workflow execution.
 * @footnote-scope: core
 * @footnote-module: ChatServicePlannerActionOutcome
 * @footnote-risk: medium - Incorrect classification can skip generation or return wrong action types.
 * @footnote-ethics: medium - Action routing affects user-visible behavior and trust.
 */
import type {
    PostChatRequest,
    PostChatResponse,
} from '@footnote/contracts/web';
import type { ChatPlan } from '../chatPlanner.js';
import type { PlannerFallbackReason } from '../plannerFallbackTelemetryRollup.js';

type PlannerTerminalAction =
    | {
          responseAction: 'ignore';
          response: PostChatResponse;
      }
    | {
          responseAction: 'react';
          response: PostChatResponse;
      }
    | {
          responseAction: 'image';
          response: PostChatResponse;
      };

export type PlannerActionOutcome =
    | {
          kind: 'continue_message';
      }
    | {
          kind: 'terminal_action';
          terminalAction: PlannerTerminalAction;
          fallbackReason?: PlannerFallbackReason;
          warningMessage?: string;
      };

export const resolvePlannerActionOutcome = (input: {
    executionPlan: ChatPlan;
    normalizedRequest: PostChatRequest;
}): PlannerActionOutcome => {
    if (input.executionPlan.action === 'ignore') {
        return {
            kind: 'terminal_action',
            terminalAction: {
                responseAction: 'ignore',
                response: {
                    action: 'ignore',
                    metadata: null,
                },
            },
        };
    }

    if (input.executionPlan.action === 'react') {
        return {
            kind: 'terminal_action',
            terminalAction: {
                responseAction: 'react',
                response: {
                    action: 'react',
                    reaction: input.executionPlan.reaction ?? '👍',
                    metadata: null,
                },
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
                response: {
                    action: 'image',
                    imageRequest: input.executionPlan.imageRequest,
                    metadata: null,
                },
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
                response: {
                    action: 'ignore',
                    metadata: null,
                },
            },
            fallbackReason: 'image_action_missing_image_request',
            warningMessage: `Chat planner returned image without imageRequest; falling back to ignore. surface=${input.normalizedRequest.surface} trigger=${input.normalizedRequest.trigger.kind} latestUserInputLength=${input.normalizedRequest.latestUserInput.length}`,
        };
    }

    return {
        kind: 'continue_message',
    };
};
