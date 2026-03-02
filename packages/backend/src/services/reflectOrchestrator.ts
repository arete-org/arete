/**
 * @description: Orchestrates universal reflect requests across web and Discord surfaces.
 * @footnote-scope: core
 * @footnote-module: ReflectOrchestrator
 * @footnote-risk: high - Routing mistakes here can send the wrong action or break reflect across surfaces.
 * @footnote-ethics: high - This is the canonical action-selection boundary for user-facing reflect behavior.
 */
import type {
    PostReflectRequest,
    PostReflectResponse,
} from '@footnote/contracts/web';
import { renderPrompt } from './prompts/promptRegistry.js';
import {
    createReflectService,
    type CreateReflectServiceOptions,
} from './reflectService.js';
import { createReflectPlanner, type ReflectPlan } from './reflectPlanner.js';
import { runtimeConfig } from '../config.js';

type CreateReflectOrchestratorOptions = CreateReflectServiceOptions;

const buildPlannerPayload = (plan: ReflectPlan): string =>
    JSON.stringify({
        action: plan.action,
        modality: plan.modality,
        reaction: plan.reaction,
        imageRequest: plan.imageRequest,
        riskTier: plan.riskTier,
        reasoning: plan.reasoning,
    });

/**
 * The orchestrator keeps surface-specific policy in one place while reusing the
 * shared message-generation service for any branch that ends in text output.
 */
export const createReflectOrchestrator = ({
    openaiService,
    storeTrace,
    buildResponseMetadata,
    defaultModel = runtimeConfig.openai.defaultModel,
    recordUsage,
}: CreateReflectOrchestratorOptions) => {
    const reflectService = createReflectService({
        openaiService,
        storeTrace,
        buildResponseMetadata,
        defaultModel,
        recordUsage,
    });
    const reflectPlanner = createReflectPlanner({
        openaiService,
        defaultModel,
    });

    const runReflect = async (
        request: PostReflectRequest
    ): Promise<PostReflectResponse> => {
        if (request.surface === 'web') {
            return reflectService.runReflect({
                question: request.latestUserInput,
            });
        }

        const plan = await reflectPlanner.planReflect(request);
        if (plan.action === 'ignore') {
            return {
                action: 'ignore',
                metadata: null,
            };
        }

        if (plan.action === 'react') {
            return {
                action: 'react',
                reaction: plan.reaction ?? '👍',
                metadata: null,
            };
        }

        if (plan.action === 'image' && plan.imageRequest) {
            return {
                action: 'image',
                imageRequest: plan.imageRequest,
                metadata: null,
            };
        }

        if (plan.action === 'image' && !plan.imageRequest) {
            return {
                action: 'ignore',
                metadata: null,
            };
        }

        const conversationMessages = [
            {
                role: 'system',
                content: renderPrompt('discord.chat.system').content,
            },
            ...request.conversation.map(
                (message: PostReflectRequest['conversation'][number]) => ({
                    role: message.role,
                    content: message.content,
                })
            ),
            {
                role: 'system',
                content: [
                    '// ==========',
                    '// BEGIN Planner Output',
                    '// This planner decision was made by the backend and should be treated as authoritative for this response.',
                    '// ==========',
                    buildPlannerPayload(plan),
                    '// ==========',
                    '// END Planner Output',
                    '// ==========',
                ].join('\n'),
            },
        ];

        const response = await reflectService.runReflectMessages({
            messages: conversationMessages,
            conversationSnapshot: JSON.stringify({
                request,
                planner: {
                    action: plan.action,
                    modality: plan.modality,
                    riskTier: plan.riskTier,
                },
            }),
            riskTier: plan.riskTier,
        });

        return {
            action: 'message',
            message: response.message,
            modality: plan.modality,
            metadata: response.metadata,
        };
    };

    return {
        runReflect,
    };
};
