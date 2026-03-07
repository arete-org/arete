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
    ReflectConversationMessage,
} from '@footnote/contracts/web';
import { renderPrompt } from './prompts/promptRegistry.js';
import {
    createReflectService,
    type CreateReflectServiceOptions,
} from './reflectService.js';
import { createReflectPlanner, type ReflectPlan } from './reflectPlanner.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type CreateReflectOrchestratorOptions = CreateReflectServiceOptions;

const buildPlannerPayload = (
    plan: ReflectPlan,
    surfacePolicy?: { coercedFrom: ReflectPlan['action'] }
): string =>
    JSON.stringify({
        action: plan.action,
        modality: plan.modality,
        reaction: plan.reaction,
        imageRequest: plan.imageRequest,
        riskTier: plan.riskTier,
        reasoning: plan.reasoning,
        generation: plan.generation,
        ...(surfacePolicy && { surfacePolicy }),
    });

const coercePlanForSurface = (
    request: PostReflectRequest,
    plan: ReflectPlan
): {
    plan: ReflectPlan;
    surfacePolicy?: { coercedFrom: ReflectPlan['action'] };
} => {
    if (request.surface !== 'web') {
        return { plan };
    }

    if (plan.action === 'message') {
        return { plan };
    }

    const coercedPlan: ReflectPlan = {
        ...plan,
        action: 'message',
        modality: 'text',
        reasoning:
            `${plan.reasoning} Web surface requires a message response, so the planner was coerced to message.`.trim(),
    };

    logger.debug(
        `Reflect surface policy coerced action ${plan.action} -> message for web request.`
    );

    return {
        plan: coercedPlan,
        surfacePolicy: { coercedFrom: plan.action },
    };
};

const buildSurfaceSystemPrompt = (
    surface: PostReflectRequest['surface']
): string =>
    surface === 'discord'
        ? renderPrompt('discord.chat.system').content
        : renderPrompt('reflect.chat.system').content;

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
        recordUsage,
    });

    const runReflect = async (
        request: PostReflectRequest
    ): Promise<PostReflectResponse> => {
        const planned = await reflectPlanner.planReflect(request);
        const { plan, surfacePolicy } = coercePlanForSurface(request, planned);

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
            logger.warn(
                `Reflect planner returned image without imageRequest; falling back to ignore. surface=${request.surface} trigger=${request.trigger.kind} latestUserInputLength=${request.latestUserInput.length}`
            );
            return {
                action: 'ignore',
                metadata: null,
            };
        }

        const conversationMessages: Array<
            Pick<ReflectConversationMessage, 'role' | 'content'>
        > = [
            {
                role: 'system',
                content: buildSurfaceSystemPrompt(request.surface),
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
                    buildPlannerPayload(plan, surfacePolicy),
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
                    generation: plan.generation,
                    ...(surfacePolicy && { surfacePolicy }),
                },
            }),
            plannerTemperament: plan.generation.temperament,
            riskTier: plan.riskTier,
            generation: plan.generation,
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
