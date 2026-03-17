/**
 * @description: Chooses the next reflect action for transport-neutral reflect requests.
 * @footnote-scope: core
 * @footnote-module: ReflectPlanner
 * @footnote-risk: high - Planner mistakes can pick the wrong modality, skip retrieval, or suppress expected replies.
 * @footnote-ethics: high - Action selection directly affects responsiveness, grounding, and user trust.
 */
import type { GenerationSearchIntent } from '@footnote/agent-runtime';
import type {
    PostReflectRequest,
    ReflectCapabilities,
    ReflectImageRequest,
} from '@footnote/contracts/web';
import type {
    RiskTier,
    ResponseTemperament,
    TraceAxisScore,
} from '@footnote/contracts/ethics-core';
import { renderPrompt } from './prompts/promptRegistry.js';
import type { OpenAIService } from './openaiService.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import type {
    ReflectGenerationPlan,
    ReflectGenerationSearch,
    ReflectRepoSearchHint,
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
const DISCORD_CUSTOM_EMOJI_PATTERN = /^<a?:[a-zA-Z0-9_]+:[0-9]{2,}>$/;
const UNICODE_SINGLE_EMOJI_PATTERN =
    /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)$/u;

/**
 * Planner decision consumed by the reflect orchestrator after the raw LLM
 * output has been normalized and safety-checked.
 */
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
        search?: Partial<ReflectGenerationSearch> & {
            repoHints?: unknown;
        };
        temperament?: unknown;
    };
};

const isDevelopment = (): boolean => runtimeConfig.runtime.isDevelopment;

/**
 * Coerces arbitrary planner output into the RiskTier contract.
 */
const normalizeRiskTier = (value: unknown): RiskTier => {
    if (value === 'Low' || value === 'Medium' || value === 'High') {
        return value;
    }

    return 'Low';
};

/**
 * Ensures TTS is only selected when the calling surface explicitly supports it.
 */
const normalizeModality = (
    value: unknown,
    capabilities: ReflectCapabilities | undefined
): 'text' | 'tts' => {
    if (value === 'tts' && capabilities?.canUseTts) {
        return 'tts';
    }

    return 'text';
};

/**
 * Normalizes planner reasoning effort into accepted generation values.
 */
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

/**
 * Normalizes planner verbosity into accepted generation values.
 */
const normalizeVerbosity = (
    value: unknown
): ReflectGenerationPlan['verbosity'] => {
    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

/**
 * Falls back to current_facts to keep invalid planner outputs fail-open.
 */
const normalizeSearchIntent = (value: unknown): GenerationSearchIntent =>
    value === 'repo_explainer' ? 'repo_explainer' : 'current_facts';

/**
 * Chooses safe search context defaults by search intent.
 */
const normalizeSearchContextSize = (
    value: unknown,
    searchIntent: GenerationSearchIntent
): ReflectGenerationSearch['contextSize'] => {
    if (searchIntent === 'repo_explainer') {
        return value === 'high' ? 'high' : 'medium';
    }

    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

/**
 * Keeps only allowed repo hints and removes duplicates.
 */
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

        const normalizedHint = rawHint
            .trim()
            .toLowerCase() as ReflectRepoSearchHint;
        if (!REPO_HINT_SET.has(normalizedHint) || seen.has(normalizedHint)) {
            continue;
        }

        seen.add(normalizedHint);
        normalized.push(normalizedHint);
    }

    return normalized;
};

const normalizeTraceAxisScore = (
    value: unknown
): TraceAxisScore | undefined => {
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 5
    ) {
        return undefined;
    }

    return value as TraceAxisScore;
};

const normalizeTemperament = (
    value: unknown
): ResponseTemperament | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const tightness = normalizeTraceAxisScore(candidate.tightness);
    const rationale = normalizeTraceAxisScore(candidate.rationale);
    const attribution = normalizeTraceAxisScore(candidate.attribution);
    const caution = normalizeTraceAxisScore(candidate.caution);
    const extent = normalizeTraceAxisScore(candidate.extent);
    if (
        tightness === undefined ||
        rationale === undefined ||
        attribution === undefined ||
        caution === undefined ||
        extent === undefined
    ) {
        return undefined;
    }

    return {
        tightness,
        rationale,
        attribution,
        caution,
        extent,
    };
};

const stripJsonFences = (content: string): string =>
    content
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();

/**
 * Keeps react actions strict so downstream transport never receives plain text
 * where an emoji token is expected.
 */
const isValidReactionEmoji = (value: string): boolean =>
    DISCORD_CUSTOM_EMOJI_PATTERN.test(value) ||
    UNICODE_SINGLE_EMOJI_PATTERN.test(value);

/**
 * Builds a conservative fallback plan used when planner output is invalid.
 */
const buildFallbackPlan = (
    request: PostReflectRequest,
    reason: string
): ReflectPlan => {
    const fallbackAction =
        request.trigger.kind === 'catchup' ? 'ignore' : 'message';

    return {
        action: fallbackAction,
        modality: 'text',
        riskTier: 'Low',
        reasoning: reason,
        // Intentionally omit fallback TRACE temperament.
        // Missing axes are rendered in red in the trace card to signal
        // unavailable planner temperament, rather than synthetic values.
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
        },
    };
};

/**
 * Produces a bounded request summary string for planner context/logging.
 */
const summarizeRequest = (request: PostReflectRequest): string =>
    JSON.stringify({
        surface: request.surface,
        trigger: request.trigger.kind,
        latestUserInputLength: request.latestUserInput.length,
        conversationMessages: request.conversation.length,
        attachmentKinds: request.attachments?.map(
            (
                attachment: NonNullable<
                    PostReflectRequest['attachments']
                >[number]
            ) => attachment.kind
        ),
        capabilities: request.capabilities,
    });

/**
 * Validates and normalizes image-generation settings from planner output.
 */
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
                ? candidate.allowPromptAdjustment.trim().toLowerCase() ===
                  'true'
                : undefined;

    return {
        prompt,
        aspectRatio,
        background:
            typeof candidate.background === 'string'
                ? candidate.background
                : undefined,
        quality,
        style:
            typeof candidate.style === 'string' ? candidate.style : undefined,
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

/**
 * Normalizes planner generation settings and safely disables invalid search.
 */
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
    };
    const normalizedTemperament = normalizeTemperament(candidate?.temperament);
    if (normalizedTemperament) {
        baseGeneration.temperament = normalizedTemperament;
    }

    if (!candidate?.search) {
        return { generation: baseGeneration };
    }

    const rawQuery =
        typeof candidate.search.query === 'string'
            ? candidate.search.query.trim()
            : '';
    if (!rawQuery) {
        return {
            generation: baseGeneration,
            reasoningSuffix: reasoning.includes('search was disabled safely')
                ? undefined
                : 'The planner requested search without a usable query, so search was disabled safely.',
        };
    }

    const searchIntent = normalizeSearchIntent(candidate.search.intent);
    const repoHints =
        searchIntent === 'repo_explainer'
            ? normalizeRepoHints(candidate.search.repoHints)
            : undefined;

    return {
        generation: {
            ...baseGeneration,
            search: {
                query: rawQuery,
                contextSize: normalizeSearchContextSize(
                    candidate.search.contextSize,
                    searchIntent
                ),
                intent: searchIntent,
                ...(repoHints && repoHints.length > 0 ? { repoHints } : {}),
            },
        },
    };
};

/**
 * Converts raw planner JSON into a fully validated internal ReflectPlan.
 */
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
            typeof candidate.reasoning === 'string' &&
            candidate.reasoning.trim()
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

        if (
            typeof candidate.reaction !== 'string' ||
            !candidate.reaction.trim()
        ) {
            return {
                ...fallbackPlan,
                reasoning:
                    `${normalizedPlan.reasoning} React action was missing emoji, so the planner fell back safely.`.trim(),
            };
        }
        const trimmedReaction = candidate.reaction.trim();
        if (!isValidReactionEmoji(trimmedReaction)) {
            return {
                ...fallbackPlan,
                reasoning:
                    `${normalizedPlan.reasoning} React action was not a valid emoji token, so the planner fell back safely.`.trim(),
            };
        }

        return {
            ...normalizedPlan,
            reaction: trimmedReaction,
            generation: {
                ...normalizedPlan.generation,
                search: undefined,
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
                search: undefined,
            },
        };
    }

    if (normalizedPlan.action === 'ignore') {
        return {
            ...normalizedPlan,
            modality: 'text',
            generation: {
                ...normalizedPlan.generation,
                search: undefined,
            },
        };
    }

    if (!normalizedPlan.generation.temperament) {
        return {
            ...fallbackPlan,
            action: 'message',
            modality: normalizedPlan.modality,
            riskTier: normalizedPlan.riskTier,
            reasoning:
                `${normalizedPlan.reasoning} Planner omitted required TRACE temperament, so the backend fell back safely.`.trim(),
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
                    maxOutputTokens: 700,
                    reasoningEffort: 'low',
                    verbosity: 'low',
                }
            );
            const usageModel = plannerResponse.metadata.model || defaultModel;
            const promptTokens =
                plannerResponse.metadata.usage?.prompt_tokens ?? 0;
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
                    `Reflect planner generation search=${normalizedPlan.generation.search ? 'enabled' : 'disabled'} reasoningEffort=${normalizedPlan.generation.reasoningEffort} verbosity=${normalizedPlan.generation.verbosity}`
                );
                if (normalizedPlan.generation.search) {
                    logger.debug(
                        `Reflect planner search intent=${normalizedPlan.generation.search.intent} query=${JSON.stringify(normalizedPlan.generation.search.query)} repoHints=${JSON.stringify(normalizedPlan.generation.search.repoHints ?? [])}`
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
