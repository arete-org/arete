/**
 * @description: Chooses the next reflect action for transport-neutral reflect requests.
 * @footnote-scope: core
 * @footnote-module: ReflectPlanner
 * @footnote-risk: high - Planner mistakes can pick the wrong modality, skip retrieval, or suppress expected replies.
 * @footnote-ethics: high - Action selection directly affects responsiveness, grounding, and user trust.
 */
import type {
    PostReflectRequest,
    ReflectCapabilities,
    ReflectImageRequest,
} from '@footnote/contracts/web';
import type { RiskTier } from '@footnote/contracts/ethics-core';
import { renderPrompt } from './prompts/promptRegistry.js';
import type { OpenAIService } from './openaiService.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import type {
    ReflectGenerationPlan,
    ReflectRepoSearchHint,
    ReflectSearchIntent,
    ReflectWebSearchPlan,
} from './reflectGenerationTypes.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type ReflectPlannerAction = 'message' | 'react' | 'ignore' | 'image';

const REPO_HINTS = [
    'architecture',
    'backend',
    'contracts',
    'discord',
    'images',
    'onboarding',
    'web',
    'observability',
    'openapi',
    'prompts',
    'provenance',
    'reflect',
    'traces',
    'voice',
] as const;

const REPO_HINT_SET = new Set<ReflectRepoSearchHint>(REPO_HINTS);

export type ReflectPlan = {
    action: ReflectPlannerAction;
    modality: 'text' | 'tts';
    reaction?: string;
    imageRequest?: ReflectImageRequest;
    riskTier: RiskTier;
    reasoning: string;
    generation: ReflectGenerationPlan;
};

type CreateReflectPlannerOptions = {
    openaiService: OpenAIService;
    defaultModel?: string;
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

type PlannerCandidate = Partial<ReflectPlan> & {
    reasoning?: unknown;
    generation?: Partial<ReflectGenerationPlan> & {
        webSearch?: Partial<ReflectWebSearchPlan> & {
            repoHints?: unknown;
        };
    };
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

const normalizeReasoningEffort = (
    value: unknown
): ReflectGenerationPlan['reasoningEffort'] => {
    if (
        value === 'minimal' ||
        value === 'low' ||
        value === 'medium' ||
        value === 'high'
    ) {
        return value;
    }

    return 'low';
};

const normalizeVerbosity = (
    value: unknown
): ReflectGenerationPlan['verbosity'] => {
    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

const normalizeSearchIntent = (value: unknown): ReflectSearchIntent =>
    value === 'repo_explainer' ? 'repo_explainer' : 'current_facts';

const normalizeSearchContextSize = (
    value: unknown,
    searchIntent: ReflectSearchIntent
): ReflectWebSearchPlan['searchContextSize'] => {
    if (searchIntent === 'repo_explainer') {
        return value === 'high' ? 'high' : 'medium';
    }

    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

const normalizeRepoHints = (value: unknown): ReflectRepoSearchHint[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set<ReflectRepoSearchHint>();
    const normalized: ReflectRepoSearchHint[] = [];

    for (const rawHint of value) {
        if (typeof rawHint !== 'string') {
            continue;
        }

        const normalizedHint = rawHint.trim().toLowerCase() as ReflectRepoSearchHint;
        if (!REPO_HINT_SET.has(normalizedHint) || seen.has(normalizedHint)) {
            continue;
        }

        seen.add(normalizedHint);
        normalized.push(normalizedHint);
    }

    return normalized;
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
    generation: {
        reasoningEffort: 'low',
        verbosity: 'low',
        toolChoice: 'none',
    },
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

    const allowPromptAdjustment =
        candidate.allowPromptAdjustment === undefined
            ? undefined
            : typeof candidate.allowPromptAdjustment === 'boolean'
              ? candidate.allowPromptAdjustment
              : typeof candidate.allowPromptAdjustment === 'string'
                ? candidate.allowPromptAdjustment.trim().toLowerCase() === 'true'
                : undefined;

    return {
        prompt,
        aspectRatio,
        background:
            typeof candidate.background === 'string'
                ? candidate.background
                : undefined,
        quality,
        style: typeof candidate.style === 'string' ? candidate.style : undefined,
        allowPromptAdjustment,
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

const normalizeGeneration = (
    candidate: PlannerCandidate['generation'],
    reasoning: string
): {
    generation: ReflectGenerationPlan;
    reasoningSuffix?: string;
} => {
    const baseGeneration: ReflectGenerationPlan = {
        reasoningEffort: normalizeReasoningEffort(candidate?.reasoningEffort),
        verbosity: normalizeVerbosity(candidate?.verbosity),
        toolChoice: candidate?.toolChoice === 'web_search' ? 'web_search' : 'none',
    };

    if (baseGeneration.toolChoice !== 'web_search') {
        return { generation: baseGeneration };
    }

    const rawQuery =
        typeof candidate?.webSearch?.query === 'string'
            ? candidate.webSearch.query.trim()
            : '';
    if (!rawQuery) {
        return {
            generation: {
                ...baseGeneration,
                toolChoice: 'none',
            },
            reasoningSuffix: reasoning.includes('search was disabled safely')
                ? undefined
                : 'The planner requested web search without a usable query, so search was disabled safely.',
        };
    }

    const searchIntent = normalizeSearchIntent(candidate?.webSearch?.searchIntent);
    const repoHints =
        searchIntent === 'repo_explainer'
            ? normalizeRepoHints(candidate?.webSearch?.repoHints)
            : [];

    return {
        generation: {
            ...baseGeneration,
            webSearch: {
                query: rawQuery,
                searchContextSize: normalizeSearchContextSize(
                    candidate?.webSearch?.searchContextSize,
                    searchIntent
                ),
                searchIntent,
                repoHints,
            },
        },
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
        generation: fallbackPlan.generation,
    };

    const normalizedGeneration = normalizeGeneration(
        candidate.generation,
        normalizedPlan.reasoning
    );
    normalizedPlan.generation = normalizedGeneration.generation;
    if (normalizedGeneration.reasoningSuffix) {
        normalizedPlan.reasoning =
            `${normalizedPlan.reasoning} ${normalizedGeneration.reasoningSuffix}`.trim();
    }

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
            generation: {
                ...normalizedPlan.generation,
                toolChoice: 'none',
                webSearch: undefined,
            },
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
            generation: {
                ...normalizedPlan.generation,
                toolChoice: 'none',
                webSearch: undefined,
            },
        };
    }

    if (normalizedPlan.action === 'ignore') {
        return {
            ...normalizedPlan,
            modality: 'text',
            generation: {
                ...normalizedPlan.generation,
                toolChoice: 'none',
                webSearch: undefined,
            },
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
    recordUsage = recordBackendLLMUsage,
}: CreateReflectPlannerOptions) => {
    const planReflect = async (
        request: PostReflectRequest
    ): Promise<ReflectPlan> => {
        const plannerPrompt = renderPrompt('reflect.planner.system').content;
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
                    reasoningEffort: 'low',
                    verbosity: 'low',
                }
            );
            const usageModel = plannerResponse.metadata.model || defaultModel;
            const promptTokens = plannerResponse.metadata.usage?.prompt_tokens ?? 0;
            const completionTokens =
                plannerResponse.metadata.usage?.completion_tokens ?? 0;
            const totalTokens =
                plannerResponse.metadata.usage?.total_tokens ??
                promptTokens + completionTokens;
            if (recordUsage) {
                try {
                    recordUsage({
                        feature: 'reflect_planner',
                        model: usageModel,
                        promptTokens,
                        completionTokens,
                        totalTokens,
                        ...estimateBackendTextCost(
                            usageModel,
                            promptTokens,
                            completionTokens
                        ),
                        timestamp: Date.now(),
                    });
                } catch (error) {
                    logger.warn(
                        `Reflect planner usage recording failed: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
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
                    `Reflect planner generation toolChoice=${normalizedPlan.generation.toolChoice} reasoningEffort=${normalizedPlan.generation.reasoningEffort} verbosity=${normalizedPlan.generation.verbosity}`
                );
                if (normalizedPlan.generation.webSearch) {
                    logger.debug(
                        `Reflect planner webSearch intent=${normalizedPlan.generation.webSearch.searchIntent} query=${JSON.stringify(normalizedPlan.generation.webSearch.query)} repoHints=${JSON.stringify(normalizedPlan.generation.webSearch.repoHints)}`
                    );
                }
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
