/**
 * @description: Applies surface-specific action policy constraints to normalized chat plans.
 * @footnote-scope: core
 * @footnote-module: ChatSurfacePolicy
 * @footnote-risk: medium - Incorrect coercion can change visible behavior across web and Discord surfaces.
 * @footnote-ethics: medium - Surface policy decides whether users get a response, reaction, or silence.
 */

import type { PostChatRequest } from '@footnote/contracts/web';
import type { ChatPlan } from './chatPlanner.js';

export type ChatSurfacePolicyResult = {
    plan: ChatPlan;
    surfacePolicy?: { coercedFrom: ChatPlan['action'] };
};

type ChatSurfacePolicyLogger = {
    debug: (message: string) => void;
};

/**
 * Enforces surface policy constraints after planning.
 * Web currently accepts message responses only.
 */
export const coercePlanForSurface = (
    request: PostChatRequest,
    plan: ChatPlan,
    logger: ChatSurfacePolicyLogger
): ChatSurfacePolicyResult => {
    // Only web is constrained to message actions today.
    if (request.surface !== 'web') {
        return { plan };
    }

    if (plan.action === 'message') {
        return { plan };
    }

    const normalizedReasoning = plan.reasoning.trim();
    const coercedPlan: ChatPlan = {
        ...plan,
        action: 'message',
        modality: 'text',
        reaction: undefined,
        imageRequest: undefined,
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
        },
        reasoning:
            `${normalizedReasoning ? `${normalizedReasoning} ` : ''}Web surface requires a message response, so the planner output was coerced to a text message.`.trim(),
    };

    logger.debug(
        `Chat surface policy coerced action ${plan.action} -> message for web request.`
    );

    return {
        plan: coercedPlan,
        surfacePolicy: { coercedFrom: plan.action },
    };
};
