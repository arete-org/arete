/**
 * @description: Chooses the next chat action for transport-neutral chat requests.
 * @footnote-scope: core
 * @footnote-module: ChatPlanner
 * @footnote-risk: high - Planner mistakes can pick the wrong modality, skip retrieval, or suppress expected replies.
 * @footnote-ethics: high - Action selection directly affects responsiveness, grounding, and user trust.
 */
import type {
    GenerationSearchIntent,
    GenerationUsage,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type {
    PostChatRequest,
    ChatCapabilities,
    ChatImageRequest,
} from '@footnote/contracts/web';
import type {
    ExecutionReasonCode,
    ExecutionStatus,
    RiskTier,
    ResponseTemperament,
    TraceAxisScore,
} from '@footnote/contracts/ethics-core';
import { renderPrompt } from './prompts/promptRegistry.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import type {
    ChatGenerationPlan,
    ChatGenerationSearch,
    ChatRepoSearchHint,
} from './chatGenerationTypes.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type ChatPlannerAction = 'message' | 'react' | 'ignore' | 'image';

export type ChatPlannerExecution = {
    status: ExecutionStatus;
    reasonCode?: ExecutionReasonCode;
    durationMs: number;
};

export type ChatPlannerResult = {
    plan: ChatPlan;
    execution: ChatPlannerExecution;
};

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
    'chat',
    'traces',
    'voice',
] as const;

const REPO_HINT_SET = new Set<ChatRepoSearchHint>(REPO_HINTS);
const DISCORD_CUSTOM_EMOJI_PATTERN = /^<a?:[a-zA-Z0-9_]+:[0-9]{2,}>$/;
const UNICODE_SINGLE_EMOJI_PATTERN =
    /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)$/u;

/**
 * Planner decision consumed by the chat orchestrator after the raw LLM
 * output has been normalized and safety-checked.
 */
export type ChatPlan = {
    action: ChatPlannerAction;
    modality: 'text' | 'tts';
    profileId?: string;
    reaction?: string;
    imageRequest?: ChatImageRequest;
    riskTier: RiskTier;
    reasoning: string;
    generation: ChatGenerationPlan;
};

export type ChatPlannerProfileOption = {
    // Stable profile key the planner can return in `profileId`.
    id: string;
    // Human-readable intent hint shown to planner; not used for matching.
    description: string;
    // Coarse planning hint only; runtime does not enforce cost from this field.
    costClass?: 'low' | 'medium' | 'high';
    // Coarse planning hint only; runtime does not enforce latency from this field.
    latencyClass?: 'low' | 'medium' | 'high';
    capabilities: {
        // Planner hint about whether search is feasible for this profile.
        canUseSearch: boolean;
    };
};

type CreateChatPlannerOptions = {
    executePlanner: ChatPlannerExecutor;
    defaultModel?: string;
    availableProfiles?: ChatPlannerProfileOption[];
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

/**
 * Narrow planner-only execution input.
 * This stays backend-local so planner policy can move off legacy OpenAI
 * without creating a second shared runtime abstraction.
 */
type ChatPlannerExecutionRequest = {
    messages: RuntimeMessage[];
    model: string;
    maxOutputTokens: number;
    reasoningEffort: ChatGenerationPlan['reasoningEffort'];
    verbosity: ChatGenerationPlan['verbosity'];
};

/**
 * Narrow planner-only execution output.
 * The planner only needs text plus enough runtime facts for logging/costs.
 */
type ChatPlannerExecutionResult = {
    text: string;
    model?: string;
    usage?: GenerationUsage;
};

type ChatPlannerExecutor = (
    request: ChatPlannerExecutionRequest
) => Promise<ChatPlannerExecutionResult>;

type PlannerCandidate = Partial<ChatPlan> & {
    profileId?: unknown;
    reasoning?: unknown;
    generation?: Partial<ChatGenerationPlan> & {
        search?: Partial<ChatGenerationSearch> & {
            repoHints?: unknown;
        };
        temperament?: unknown;
    };
};

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
    capabilities: ChatCapabilities | undefined
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
): ChatGenerationPlan['reasoningEffort'] => {
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
): ChatGenerationPlan['verbosity'] => {
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
): ChatGenerationSearch['contextSize'] => {
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
const normalizeRepoHints = (value: unknown): ChatRepoSearchHint[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set<ChatRepoSearchHint>();
    const normalized: ChatRepoSearchHint[] = [];

    for (const rawHint of value) {
        if (typeof rawHint !== 'string') {
            continue;
        }

        const normalizedHint = rawHint
            .trim()
            .toLowerCase() as ChatRepoSearchHint;
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

const normalizeProfileId = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    // Blank ids are treated as "no planner preference" so orchestrator can
    // fail open to its default response profile.
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
};

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
    request: PostChatRequest,
    reason: string
): ChatPlan => {
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
const summarizeRequest = (request: PostChatRequest): string =>
    JSON.stringify({
        surface: request.surface,
        trigger: request.trigger.kind,
        latestUserInputLength: request.latestUserInput.length,
        conversationMessages: request.conversation.length,
        attachmentKinds: request.attachments?.map(
            (attachment: NonNullable<PostChatRequest['attachments']>[number]) =>
                attachment.kind
        ),
        capabilities: request.capabilities,
    });

/**
 * Validates and normalizes image-generation settings from planner output.
 */
const normalizeImageRequest = (
    value: unknown
): ChatImageRequest | undefined => {
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
    generation: ChatGenerationPlan;
    reasoningSuffix?: string;
} => {
    const baseGeneration: ChatGenerationPlan = {
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
 * Converts raw planner JSON into a fully validated internal ChatPlan.
 */
const normalizePlan = (
    request: PostChatRequest,
    candidate: PlannerCandidate
): ChatPlan => {
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

    const normalizedPlan: ChatPlan = {
        action: actionCandidate,
        modality: normalizeModality(candidate.modality, capabilities),
        profileId: normalizeProfileId(candidate.profileId),
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
 * Builds the backend-native planner used by the universal chat workflow.
 * It returns an internal plan shape and logs its reasoning in development so
 * planner drift is visible during pre-production rollout.
 */
export const createChatPlanner = ({
    executePlanner,
    defaultModel = runtimeConfig.openai.defaultModel,
    availableProfiles = [],
    recordUsage = recordBackendLLMUsage,
}: CreateChatPlannerOptions) => {
    // Keep planner context intentionally narrow.
    // We expose only decision-relevant fields, not full raw catalog config.
    const plannerProfileContext =
        availableProfiles.length > 0
            ? JSON.stringify(
                  availableProfiles.map((profile) => ({
                      id: profile.id,
                      description: profile.description,
                      costClass: profile.costClass,
                      latencyClass: profile.latencyClass,
                      capabilities: profile.capabilities,
                  }))
              )
            : '[]';

    const planChat = async (
        request: PostChatRequest
    ): Promise<ChatPlannerResult> => {
        const plannerStartedAt = Date.now();
        const plannerPrompt = renderPrompt('chat.planner.system').content;
        const requestSummary = summarizeRequest(request);
        const plannerMessages: RuntimeMessage[] = [
            { role: 'system', content: plannerPrompt },
            {
                // The prompt instructs planner to choose one id from this list.
                // The orchestrator still validates the chosen id before use.
                role: 'system',
                content: `Planner profile options (bounded): ${plannerProfileContext}`,
            },
            {
                role: 'system',
                content: `Planner request summary: ${requestSummary}`,
            },
            {
                role: 'system',
                content: `This request was triggered because ${request.trigger.kind}.`,
            },
            ...request.conversation.map(
                (message: PostChatRequest['conversation'][number]) => ({
                    role: message.role,
                    content: message.content,
                })
            ),
        ];

        try {
            const plannerResponse = await executePlanner({
                messages: plannerMessages,
                model: defaultModel,
                maxOutputTokens: 700,
                reasoningEffort: 'low',
                verbosity: 'low',
            });
            const usageModel = plannerResponse.model || defaultModel;
            const promptTokens = plannerResponse.usage?.promptTokens ?? 0;
            const completionTokens =
                plannerResponse.usage?.completionTokens ?? 0;
            const totalTokens =
                plannerResponse.usage?.totalTokens ??
                promptTokens + completionTokens;
            if (recordUsage) {
                try {
                    recordUsage({
                        feature: 'chat_planner',
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
                        `Chat planner usage recording failed: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
            const rawPlan = stripJsonFences(plannerResponse.text);
            const parsed = JSON.parse(rawPlan) as PlannerCandidate;
            const normalizedPlan = normalizePlan(request, parsed);

            /*
            if (isDevelopment()) {
                logger.debug(
                    `Chat planner decision summary: ${requestSummary}`
                );
                logger.debug(
                    `Chat planner chose action=${normalizedPlan.action} modality=${normalizedPlan.modality} riskTier=${normalizedPlan.riskTier}`
                );
                logger.debug(
                    `Chat planner generation search=${normalizedPlan.generation.search ? 'enabled' : 'disabled'} reasoningEffort=${normalizedPlan.generation.reasoningEffort} verbosity=${normalizedPlan.generation.verbosity}`
                );
                if (normalizedPlan.generation.search) {
                    logger.debug(
                        `Chat planner search intent=${normalizedPlan.generation.search.intent} query=${JSON.stringify(normalizedPlan.generation.search.query)} repoHints=${JSON.stringify(normalizedPlan.generation.search.repoHints ?? [])}`
                    );
                }
                logger.debug(
                    `Chat planner reasoning: ${normalizedPlan.reasoning}`
                );
            }
            */

            return {
                plan: normalizedPlan,
                execution: {
                    status: 'executed',
                    durationMs: Date.now() - plannerStartedAt,
                },
            };
        } catch (error) {
            const fallbackPlan = buildFallbackPlan(
                request,
                'Planner failed, so the backend used a safe fallback.'
            );
            const reasonCode: ExecutionReasonCode =
                error instanceof SyntaxError
                    ? 'planner_invalid_output'
                    : 'planner_runtime_error';
            logger.warn(
                `Chat planner failed; using fallback action=${fallbackPlan.action}. Error: ${error instanceof Error ? error.message : String(error)}`
            );
            return {
                plan: fallbackPlan,
                execution: {
                    status: 'failed',
                    reasonCode,
                    durationMs: Date.now() - plannerStartedAt,
                },
            };
        }
    };

    return {
        planChat,
    };
};
