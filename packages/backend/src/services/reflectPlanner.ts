/**
 * @description: Chooses the next reflect action for transport-neutral reflect requests.
 * @footnote-scope: core
 * @footnote-module: ReflectPlanner
 * @footnote-risk: high - Planner mistakes can pick the wrong modality or skip expected replies.
 * @footnote-ethics: high - Action selection directly affects responsiveness, safety, and user trust.
 */
import type {
    PostReflectRequest,
    ReflectCapabilities,
    ReflectImageRequest,
} from '@footnote/contracts/web';
import type { RiskTier } from '@footnote/contracts/ethics-core';
import { renderPrompt } from './prompts/promptRegistry.js';
import type { OpenAIService } from './openaiService.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type ReflectPlannerAction = 'message' | 'react' | 'ignore' | 'image';

export type ReflectPlan = {
    action: ReflectPlannerAction;
    modality: 'text' | 'tts';
    reaction?: string;
    imageRequest?: ReflectImageRequest;
    riskTier: RiskTier;
    reasoning: string;
};

type CreateReflectPlannerOptions = {
    openaiService: OpenAIService;
    defaultModel?: string;
};

type PlannerCandidate = Partial<ReflectPlan> & {
    reasoning?: unknown;
};

const isDevelopment = (): boolean => process.env.NODE_ENV !== 'production';

const normalizeRiskTier = (value: unknown): RiskTier => {
    if (value === 'Low' || value === 'Medium' || value === 'High') {
        return value;
    }
    return 'Low';
};

const normalizeModality = (
    value: unknown,
    capabilities: ReflectCapabilities | undefined
): 'text' | 'tts' => {
    if (value === 'tts' && capabilities?.canUseTts) {
        return 'tts';
    }
    return 'text';
};

const stripJsonFences = (content: string): string =>
    content
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();

const buildFallbackPlan = (
    request: PostReflectRequest,
    reason: string
): ReflectPlan => ({
    action: request.trigger.kind === 'catchup' ? 'ignore' : 'message',
    modality: 'text',
    riskTier: 'Low',
    reasoning: reason,
});

const summarizeRequest = (request: PostReflectRequest): string =>
    JSON.stringify({
        surface: request.surface,
        trigger: request.trigger.kind,
        latestUserInputLength: request.latestUserInput.length,
        conversationMessages: request.conversation.length,
        attachmentKinds: request.attachments?.map(
            (
                attachment: NonNullable<PostReflectRequest['attachments']>[number]
            ) => attachment.kind
        ),
        capabilities: request.capabilities,
    });

const normalizeImageRequest = (
    value: unknown
): ReflectImageRequest | undefined => {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const prompt =
        typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';
    if (!prompt) {
        return undefined;
    }

    const aspectRatio =
        candidate.aspectRatio === 'auto' ||
        candidate.aspectRatio === 'square' ||
        candidate.aspectRatio === 'portrait' ||
        candidate.aspectRatio === 'landscape'
            ? candidate.aspectRatio
            : undefined;
    const quality =
        candidate.quality === 'low' ||
        candidate.quality === 'medium' ||
        candidate.quality === 'high' ||
        candidate.quality === 'auto'
            ? candidate.quality
            : undefined;
    const outputFormat =
        candidate.outputFormat === 'png' ||
        candidate.outputFormat === 'webp' ||
        candidate.outputFormat === 'jpeg'
            ? candidate.outputFormat
            : undefined;
    const outputCompression = Number(candidate.outputCompression);

    return {
        prompt,
        aspectRatio,
        background:
            typeof candidate.background === 'string'
                ? candidate.background
                : undefined,
        quality,
        style: typeof candidate.style === 'string' ? candidate.style : undefined,
        allowPromptAdjustment:
            candidate.allowPromptAdjustment === undefined
                ? undefined
                : Boolean(candidate.allowPromptAdjustment),
        followUpResponseId:
            typeof candidate.followUpResponseId === 'string'
                ? candidate.followUpResponseId
                : undefined,
        outputFormat,
        outputCompression: Number.isFinite(outputCompression)
            ? Math.min(100, Math.max(1, Math.round(outputCompression)))
            : undefined,
    };
};

const normalizePlan = (
    request: PostReflectRequest,
    candidate: PlannerCandidate
): ReflectPlan => {
    const fallbackPlan = buildFallbackPlan(
        request,
        'Planner returned an invalid or incomplete decision.'
    );
    const capabilities = request.capabilities;
    const actionCandidate =
        candidate.action === 'message' ||
        candidate.action === 'react' ||
        candidate.action === 'ignore' ||
        candidate.action === 'image'
            ? candidate.action
            : fallbackPlan.action;

    const normalizedPlan: ReflectPlan = {
        action: actionCandidate,
        modality: normalizeModality(candidate.modality, capabilities),
        riskTier: normalizeRiskTier(candidate.riskTier),
        reasoning:
            typeof candidate.reasoning === 'string' && candidate.reasoning.trim()
                ? candidate.reasoning.trim()
                : fallbackPlan.reasoning,
    };

    if (normalizedPlan.action === 'react') {
        if (!capabilities?.canReact) {
            return {
                ...fallbackPlan,
                reasoning:
                    `${normalizedPlan.reasoning} React was not allowed by caller capabilities, so the planner fell back safely.`.trim(),
            };
        }

        if (typeof candidate.reaction !== 'string' || !candidate.reaction.trim()) {
            return {
                ...fallbackPlan,
                reasoning:
                    `${normalizedPlan.reasoning} React action was missing emoji, so the planner fell back safely.`.trim(),
            };
        }

        return {
            ...normalizedPlan,
            reaction: candidate.reaction.trim(),
        };
    }

    if (normalizedPlan.action === 'image') {
        if (!capabilities?.canGenerateImages) {
            return {
                ...fallbackPlan,
                reasoning:
                    `${normalizedPlan.reasoning} Image generation was not allowed by caller capabilities, so the planner fell back safely.`.trim(),
            };
        }

        const imageRequest = normalizeImageRequest(candidate.imageRequest);
        if (!imageRequest) {
            return {
                ...fallbackPlan,
                reasoning:
                    `${normalizedPlan.reasoning} Image action was missing a valid image request, so the planner fell back safely.`.trim(),
            };
        }

        return {
            ...normalizedPlan,
            modality: 'text',
            imageRequest,
        };
    }

    if (normalizedPlan.action === 'ignore') {
        return {
            ...normalizedPlan,
            modality: 'text',
        };
    }

    return normalizedPlan;
};

/**
 * Builds the backend-native planner used by the universal reflect workflow.
 * It returns an internal plan shape and logs its reasoning in development so
 * planner drift is visible during pre-production rollout.
 */
export const createReflectPlanner = ({
    openaiService,
    defaultModel = runtimeConfig.openai.defaultModel,
}: CreateReflectPlannerOptions) => {
    const planReflect = async (
        request: PostReflectRequest
    ): Promise<ReflectPlan> => {
        const plannerPrompt = [
            renderPrompt('discord.planner.system', {
                webSearchHint:
                    'Ignore web_search/tool_choice output for this endpoint. Focus only on choosing the best action for the current surface and capabilities.',
            }).content,
            'Return plain JSON only. Do not include markdown or code fences.',
            'The JSON object must include: action, modality, riskTier, reasoning.',
            'If action is "react", include reaction as emoji-only text.',
            'If action is "image", include imageRequest with at least a prompt.',
            'Use modality "tts" only when the caller allows TTS and spoken delivery is clearly the best fit.',
            'Reasoning should be one short sentence explaining why this action fits the request.',
            'When in doubt, prefer "message" for direct or invoked requests, and "ignore" for passive catchup.',
        ].join('\n');

        const requestSummary = summarizeRequest(request);
        const plannerMessages = [
            { role: 'system', content: plannerPrompt },
            {
                role: 'system',
                content: `Planner request summary: ${requestSummary}`,
            },
            {
                role: 'system',
                content: `This request was triggered because ${request.trigger.kind}.`,
            },
            ...request.conversation.map(
                (message: PostReflectRequest['conversation'][number]) => ({
                role: message.role,
                content: message.content,
                })
            ),
        ];

        try {
            const plannerResponse = await openaiService.generateResponse(
                defaultModel,
                plannerMessages,
                {
                    expectMetadata: false,
                    maxCompletionTokens: 700,
                }
            );
            const rawPlan = stripJsonFences(plannerResponse.normalizedText);
            const parsed = JSON.parse(rawPlan) as PlannerCandidate;
            const normalizedPlan = normalizePlan(request, parsed);

            if (isDevelopment()) {
                logger.debug(
                    `Reflect planner decision summary: ${requestSummary}`
                );
                logger.debug(
                    `Reflect planner chose action=${normalizedPlan.action} modality=${normalizedPlan.modality} riskTier=${normalizedPlan.riskTier}`
                );
                logger.debug(
                    `Reflect planner reasoning: ${normalizedPlan.reasoning}`
                );
            }

            return normalizedPlan;
        } catch (error) {
            const fallbackPlan = buildFallbackPlan(
                request,
                'Planner failed, so the backend used a safe fallback.'
            );
            logger.warn(
                `Reflect planner failed; using fallback action=${fallbackPlan.action}. Error: ${error instanceof Error ? error.message : String(error)}`
            );
            return fallbackPlan;
        }
    };

    return {
        planReflect,
    };
};
