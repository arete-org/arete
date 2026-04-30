/**
 * @description: Assembles post-plan generation messages and conversation
 * snapshot payloads from policy-applied planner output.
 * @footnote-scope: core
 * @footnote-module: ChatServicePlanGenerationInput
 * @footnote-risk: medium - Incorrect assembly can desync planner payload context from generation.
 * @footnote-ethics: high - Stable assembly preserves auditable boundaries between planner advice and policy authority.
 */
import type {
    ChatConversationMessage,
    PostChatRequest,
} from '@footnote/contracts/web';
import type {
    SafetyTier,
    ToolInvocationRequest,
} from '@footnote/contracts/ethics-core';
import type { PlannerPayloadChatPlan } from '../chatOrchestrator/plannerPayload.js';
import { buildPlannerPayload } from '../chatOrchestrator/plannerPayload.js';
import type { ChatGenerationToolIntent } from '../chatGenerationTypes.js';

export type PostPlanAssemblyInput = {
    systemPrompt: string;
    personaPrompt: string;
    normalizedConversation: Array<
        Pick<ChatConversationMessage, 'role' | 'content'>
    >;
    executionPlanForPrompt: PlannerPayloadChatPlan;
    surfacePolicy?: { coercedFrom: 'message' | 'react' | 'ignore' | 'image' };
    normalizedRequest: PostChatRequest;
    orchestrationSafetyTier: SafetyTier;
    toolIntent?: ChatGenerationToolIntent;
    toolRequestContext: ToolInvocationRequest;
    executionContract: {
        policyId: string;
        policyVersion: string;
    };
};

export type PostPlanAssemblyResult = {
    conversationMessages: Array<
        Pick<ChatConversationMessage, 'role' | 'content'>
    >;
    conversationSnapshot: string;
};

export const assemblePlanGenerationInput = (
    input: PostPlanAssemblyInput
): PostPlanAssemblyResult => {
    const conversationMessages: Array<
        Pick<ChatConversationMessage, 'role' | 'content'>
    > = [
        {
            role: 'system',
            content: input.systemPrompt,
        },
        {
            role: 'system',
            content: input.personaPrompt,
        },
        ...input.normalizedConversation,
        {
            role: 'system',
            content: [
                '// ==========',
                '// BEGIN Planner Output',
                '// This bounded planner output was selected by backend policy for this response.',
                '// It is execution input for this run, not execution-contract authority.',
                '// ==========',
                buildPlannerPayload(
                    input.executionPlanForPrompt,
                    input.surfacePolicy
                ),
                '// ==========',
                '// END Planner Output',
                '// ==========',
            ].join('\n'),
        },
    ];

    const conversationSnapshot = JSON.stringify({
        request: input.normalizedRequest,
        planner: {
            action: input.executionPlanForPrompt.action,
            modality: input.executionPlanForPrompt.modality,
            profileId: input.executionPlanForPrompt.profileId,
            safetyTier: input.orchestrationSafetyTier,
            generation: input.executionPlanForPrompt.generation,
            toolIntent: input.toolIntent,
            toolRequest: input.toolRequestContext,
            ...(input.surfacePolicy && { surfacePolicy: input.surfacePolicy }),
        },
        executionContract: {
            policyId: input.executionContract.policyId,
            policyVersion: input.executionContract.policyVersion,
        },
    });

    return {
        conversationMessages,
        conversationSnapshot,
    };
};
