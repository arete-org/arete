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
import {
    chatRepoSearchHints,
    type ChatRepoSearchHint,
} from '@footnote/contracts';
import type {
    ExecutionReasonCode,
    PlannerExecutionContractType,
    PlannerExecutionPurpose,
    ExecutionStatus,
    SafetyTier,
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
    ChatGenerationWeatherLocation,
} from './chatGenerationTypes.js';
import {
    normalizeRequestedCapabilityProfile,
    type CapabilityProfileId,
} from './modelCapabilityPolicy.js';
import {
    assessPlannerOutputContract,
    type PlannerContractAssessment,
    type PlannerOutputApplyOutcome,
} from './chatPlannerOutputContract.js';
import {
    logPlannerOutputIngestion,
    logPlannerPolicyInvalidFallback,
} from './chatPlannerTelemetry.js';
import {
    buildPlannerInvocationRejectionLogMeta,
    isWorkflowOwnedPlannerInvocation,
} from './chatPlannerInvocation.js';
import type { ChatPlannerInvocationContext } from './chatPlannerInvocation.js';
export type {
    ChatPlannerInvocationContext,
    ChatPlannerInvocationPurpose,
} from './chatPlannerInvocation.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type ChatPlannerAction = 'message' | 'react' | 'ignore' | 'image';

export type ChatPlannerExecution = {
    // "executed" means we parsed/normalized planner output successfully.
    // "failed" means we fell back to a backend-safe default plan.
    status: ExecutionStatus;
    // Required when status is failed/skipped by contract-level validation.
    reasonCode?: ExecutionReasonCode;
    // Planner call + parse/normalize duration in milliseconds.
    durationMs: number;
    plannerAttemptIndex?: number;
    contextTier?: PlannerContextTier;
    selectedAttempt?: PlannerSelectedAttempt;
    contextReasonCode?: PlannerContextReasonCode;
    purpose: PlannerExecutionPurpose;
    contractType: PlannerExecutionContractType;
};

export type ChatPlannerResult = {
    // Always populated: either planner-derived or fail-open fallback plan.
    // Use this normalized plan, not the raw model output.
    plan: ChatPlan;
    // Execution telemetry used by orchestrator metadata emission.
    execution: ChatPlannerExecution;
    // Planner tool-intent diagnostics for orchestration observability.
    diagnostics: PlannerToolIntentDiagnostics;
};

export type PlannerToolIntentDiagnostics = {
    rawToolIntentPresent: boolean;
    rawToolIntentName?: string;
    normalizedToolIntentPresent: boolean;
    normalizedToolIntentName?: string;
    toolIntentRejected: boolean;
    toolIntentRejectionReasons: string[];
};

type PlannerFallbackTier = 'none' | 'field_corrections' | 'safe_default_plan';
type PlannerContextNeed = 'sufficient' | 'needs_more_context';
type PlannerContextTier =
    | 'current_window'
    | 'expanded_recent'
    | 'expanded_with_summary';
type PlannerSelectedAttempt = 'initial' | 'expanded';
type PlannerContextReasonCode =
    | 'planner_context_expanded'
    | 'planner_expansion_rejected'
    | 'planner_expansion_invalid_fallback_initial'
    | 'planner_context_budget_exhausted'
    | 'planner_context_timeout_fail_open';

export type PlannerNormalizationResult = {
    // Plan after we cleaned up planner output and filled in safe defaults.
    plan: ChatPlan;
    // How much we had to correct or fall back before the plan was safe to use.
    fallbackTier: PlannerFallbackTier;
    correctionCodes: string[];
    contextNeed: PlannerContextNeed;
    contextTier: PlannerContextTier;
    // Whether the caller could use the candidate as-is or had to adjust it.
    applyOutcome: PlannerOutputApplyOutcome;
    outOfContractFields: string[];
    authorityFieldAttempts: string[];
    diagnostics: PlannerToolIntentDiagnostics;
};

const REPO_HINT_SET = new Set<ChatRepoSearchHint>(chatRepoSearchHints);
const DISCORD_CUSTOM_EMOJI_PATTERN = /^<a?:[a-zA-Z0-9_]+:[0-9]{2,}>$/;
const UNICODE_SINGLE_EMOJI_PATTERN =
    /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)$/u;

/**
 * Planner decision consumed by the chat orchestrator after the raw LLM
 * output has been normalized and safety-checked.
 *
 * This is what the planner wanted us to do after normalization. It is still
 * just input to orchestration. Surface rules, profile selection, and tool
 * availability can still change the final behavior.
 */
export type ChatPlan = {
    action: ChatPlannerAction;
    modality: 'text' | 'tts';
    // Runtime-resolved profile id written by orchestrator, not planner output.
    profileId?: string;
    // Planner-suggested capability profile for generation profile selection.
    requestedCapabilityProfile?: CapabilityProfileId;
    // Orchestrator-selected capability profile used to resolve profileId.
    selectedCapabilityProfile?: CapabilityProfileId;
    reaction?: string;
    imageRequest?: ChatImageRequest;
    safetyTier: SafetyTier;
    reasoning: string;
    generation: ChatGenerationPlan;
};

export type ChatPlannerCapabilityProfileOption = {
    id: CapabilityProfileId;
    // Short description shown to the planner so it can ask for the right kind
    // of model. The final model can still change after routing and fallback.
    description: string;
};

type CreateChatPlannerOptions = {
    executePlanner?: ChatPlannerExecutor;
    executePlannerStructured?: ChatPlannerStructuredExecutor;
    allowTextJsonCompatibilityFallback?: boolean;
    defaultModel?: string;
    structuredExecutionTimeoutMs?: number;
    availableCapabilityProfiles?: ChatPlannerCapabilityProfileOption[];
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

/**
 * Narrow planner-only execution input.
 * This stays backend-local so planner policy can evolve beyond current providers
 * without creating a second shared runtime abstraction.
 */
type ChatPlannerExecutionRequest = {
    messages: RuntimeMessage[];
    model: string;
    maxOutputTokens: number;
    reasoningEffort: ChatGenerationPlan['reasoningEffort'];
    verbosity?: ChatGenerationPlan['verbosity'];
    signal?: AbortSignal;
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

type ChatPlannerStructuredExecutionResult = {
    decision: unknown;
    model?: string;
    usage?: GenerationUsage;
    rawArguments?: string;
};

type ChatPlannerStructuredExecutor = (
    request: ChatPlannerExecutionRequest
) => Promise<ChatPlannerStructuredExecutionResult>;
type ChatPlannerExecutionMode = 'structured' | 'text_json';

export type PlannerCandidate = Partial<ChatPlan> & {
    requestedCapabilityProfile?: unknown;
    reasoning?: unknown;
    contextNeed?: unknown;
    contextTier?: unknown;
    generation?: Partial<ChatGenerationPlan> & {
        search?: Partial<ChatGenerationSearch> & {
            repoHints?: unknown;
            topicHints?: unknown;
        };
        weather?: unknown;
        temperament?: unknown;
    };
};

const isPlannerCandidate = (value: unknown): value is PlannerCandidate =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const TOPIC_HINT_MAX_COUNT = 5;
const TOPIC_HINT_MAX_LENGTH = 40;
const CURRENT_WINDOW_MESSAGE_LIMIT = 6;
const EXPANDED_RECENT_MESSAGE_LIMIT = 20;

/**
 * Coerces arbitrary planner output into the SafetyTier contract.
 */
const normalizeSafetyTier = (value: unknown): SafetyTier => {
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

/**
 * Keeps bounded topic hints and removes duplicates.
 * These are advisory signals only, so invalid entries are dropped fail-open.
 */
const normalizeTopicHints = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const rawHint of value) {
        if (typeof rawHint !== 'string') {
            continue;
        }

        const normalizedHint = rawHint.trim().toLowerCase();
        if (
            normalizedHint.length === 0 ||
            normalizedHint.length > TOPIC_HINT_MAX_LENGTH ||
            seen.has(normalizedHint)
        ) {
            continue;
        }

        seen.add(normalizedHint);
        normalized.push(normalizedHint);
        if (normalized.length >= TOPIC_HINT_MAX_COUNT) {
            break;
        }
    }

    return normalized;
};

const normalizeWeatherLocation = (
    value: unknown
): ChatGenerationWeatherLocation | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const latitude = candidate.latitude;
    const longitude = candidate.longitude;
    const hasValidLatLon =
        typeof latitude === 'number' &&
        Number.isFinite(latitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        typeof longitude === 'number' &&
        Number.isFinite(longitude) &&
        longitude >= -180 &&
        longitude <= 180;

    const query = typeof candidate.query === 'string' ? candidate.query : '';
    const trimmedQuery = query.trim();
    const countryCodeRaw =
        typeof candidate.countryCode === 'string' ? candidate.countryCode : '';
    const countryCodeNormalized = countryCodeRaw.trim().toUpperCase();
    const hasValidPlaceQuery = trimmedQuery.length > 0;
    const hasValidCountryCode =
        countryCodeNormalized.length === 2 &&
        /^[A-Z]{2}$/.test(countryCodeNormalized);

    // Mixed location shapes are ambiguous; fail open by disabling weather.
    if (hasValidLatLon && hasValidPlaceQuery) {
        return undefined;
    }

    if (hasValidLatLon) {
        return {
            type: 'lat_lon',
            latitude,
            longitude,
        };
    }

    if (hasValidPlaceQuery) {
        return {
            type: 'place_query',
            query: trimmedQuery,
            ...(hasValidCountryCode && {
                countryCode: countryCodeNormalized,
            }),
        };
    }

    return undefined;
};

const normalizeToolIntent = (
    value: unknown
): ChatGenerationPlan['toolIntent'] | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const toolName = candidate.toolName;
    if (typeof toolName !== 'string') {
        return undefined;
    }

    const requested =
        typeof candidate.requested === 'boolean' ? candidate.requested : true;

    if (toolName === 'weather_forecast') {
        const input = candidate.input as
            | { location?: unknown; horizonPeriods?: unknown }
            | undefined;
        const hasLocation = input?.location !== undefined;
        const locationInput = hasLocation
            ? input.location
            : (input ?? candidate);
        if (!hasLocation) {
            logger.warn(
                `weather_forecast: using fallback location input (input.location missing)`,
                {
                    toolName: 'weather_forecast',
                    hasInput: input !== undefined,
                    hasLocation: false,
                }
            );
        }
        const location = normalizeWeatherLocation(locationInput);
        if (!location) {
            return undefined;
        }

        const horizonPeriods =
            typeof input?.horizonPeriods === 'number' &&
            Number.isFinite(input.horizonPeriods)
                ? Math.min(12, Math.max(1, Math.round(input.horizonPeriods)))
                : undefined;

        return {
            toolName: 'weather_forecast',
            requested,
            input: {
                location,
                ...(horizonPeriods !== undefined && { horizonPeriods }),
            },
        };
    }

    // generation.search is the canonical planner path for search. This branch is
    // kept as a compatibility guard for older or stale planner outputs that still
    // emit toolIntent.web_search. It validates and normalizes the payload rather
    // than treating arbitrary input as executable.
    if (toolName === 'web_search') {
        const input = candidate.input as Record<string, unknown> | undefined;
        if (!input || typeof input !== 'object') {
            return undefined;
        }
        const query = input.query;
        if (typeof query !== 'string' || query.trim().length === 0) {
            logger.warn('web_search: missing or invalid query', {
                toolName: 'web_search',
                hasQuery: typeof query === 'string',
            });
            return undefined;
        }
        const contextSize = input.contextSize;
        if (
            contextSize !== undefined &&
            (typeof contextSize !== 'string' ||
                !['low', 'medium', 'high'].includes(contextSize))
        ) {
            logger.warn('web_search: invalid contextSize', {
                toolName: 'web_search',
                contextSize,
            });
            return undefined;
        }
        return {
            toolName: 'web_search',
            requested,
            input: {
                query: query.trim(),
                ...(contextSize !== undefined && { contextSize }),
                ...(typeof input.intent === 'string' && {
                    intent: input.intent,
                }),
            },
        };
    }

    return undefined;
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

const parsePlannerCandidateFromTextJson = (content: string): unknown =>
    JSON.parse(stripJsonFences(content)) as unknown;

const createTimeoutSignal = ({
    timeoutMs,
    callerSignal,
}: {
    timeoutMs: number;
    callerSignal?: AbortSignal;
}): {
    signal: AbortSignal;
    cleanup: () => void;
    timedOut: () => boolean;
} => {
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutHandle = setTimeout(() => {
        didTimeout = true;
        controller.abort();
    }, timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
        if (callerSignal.aborted) {
            controller.abort();
        } else {
            callerSignal.addEventListener('abort', onCallerAbort, {
                once: true,
            });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutHandle);
            if (callerSignal) {
                callerSignal.removeEventListener('abort', onCallerAbort);
            }
        },
        timedOut: () => didTimeout,
    };
};

const normalizePlannerContextNeed = (value: unknown): PlannerContextNeed =>
    value === 'needs_more_context' ? 'needs_more_context' : 'sufficient';

const normalizePlannerContextTier = (value: unknown): PlannerContextTier => {
    if (
        value === 'current_window' ||
        value === 'expanded_recent' ||
        value === 'expanded_with_summary'
    ) {
        return value;
    }

    return 'current_window';
};

const summarizeConversationWindow = (
    conversation: PostChatRequest['conversation'],
    retainedRecentWindowSize: number
): string => {
    const droppedMessageCount = Math.max(
        0,
        conversation.length - retainedRecentWindowSize
    );
    const slicedMessages = conversation.slice(0, droppedMessageCount);
    if (slicedMessages.length === 0) {
        return 'No older conversation context was dropped.';
    }

    return slicedMessages
        .map((message, index) => {
            const compactContent = message.content
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 140);
            return `[${index + 1}] ${message.role}: ${compactContent}`;
        })
        .join(' | ');
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
        safetyTier: 'Low',
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

const buildPlannerConversationSlice = (
    request: PostChatRequest,
    contextTier: PlannerContextTier
): PostChatRequest['conversation'] => {
    const conversationLimit =
        contextTier === 'current_window'
            ? CURRENT_WINDOW_MESSAGE_LIMIT
            : EXPANDED_RECENT_MESSAGE_LIMIT;
    return request.conversation.slice(-conversationLimit);
};

const buildPlannerMessages = (input: {
    plannerPrompt: string;
    plannerProfileContext: string;
    requestSummary: string;
    request: PostChatRequest;
    contextTier: PlannerContextTier;
}): RuntimeMessage[] => [
    { role: 'system', content: input.plannerPrompt },
    {
        role: 'system',
        content: `Planner capability profiles (bounded): ${input.plannerProfileContext}`,
    },
    {
        role: 'system',
        content: `Planner request summary: ${input.requestSummary}`,
    },
    {
        role: 'system',
        content: `This request was triggered because ${input.request.trigger.kind}.`,
    },
    {
        role: 'system',
        content: `Planner context tier: ${input.contextTier}`,
    },
    ...(input.contextTier === 'expanded_with_summary'
        ? [
              {
                  role: 'system' as const,
                  content: `Conversation digest: ${summarizeConversationWindow(input.request.conversation, EXPANDED_RECENT_MESSAGE_LIMIT)}`,
              },
          ]
        : []),
    ...buildPlannerConversationSlice(input.request, input.contextTier).map(
        (message: PostChatRequest['conversation'][number]) => ({
            role: message.role,
            content: message.content,
        })
    ),
];

const hasContextExpansionBudget = (
    request: PostChatRequest,
    contextTier: PlannerContextTier
): boolean => {
    if (contextTier === 'expanded_with_summary') {
        return true;
    }

    return request.conversation.length > CURRENT_WINDOW_MESSAGE_LIMIT;
};

const hasMaterialPlanChange = (
    initialPlan: ChatPlan,
    expandedPlan: ChatPlan
): boolean => {
    const initialPlanRecord = initialPlan as unknown as Record<string, unknown>;
    const expandedPlanRecord = expandedPlan as unknown as Record<
        string,
        unknown
    >;
    if (
        initialPlan.action !== expandedPlan.action ||
        initialPlan.modality !== expandedPlan.modality ||
        initialPlan.safetyTier !== expandedPlan.safetyTier ||
        initialPlan.requestedCapabilityProfile !==
            expandedPlan.requestedCapabilityProfile
    ) {
        return true;
    }

    if (
        initialPlan.generation.reasoningEffort !==
            expandedPlan.generation.reasoningEffort ||
        initialPlan.generation.verbosity !==
            expandedPlan.generation.verbosity ||
        JSON.stringify(initialPlan.generation.temperament) !==
            JSON.stringify(expandedPlan.generation.temperament)
    ) {
        return true;
    }

    return (
        JSON.stringify({
            traceEnabled: initialPlanRecord.traceEnabled,
            requestTrace: initialPlanRecord.requestTrace,
            trace: initialPlanRecord.trace,
        }) !==
            JSON.stringify({
                traceEnabled: expandedPlanRecord.traceEnabled,
                requestTrace: expandedPlanRecord.requestTrace,
                trace: expandedPlanRecord.trace,
            }) ||
        JSON.stringify(initialPlan.generation.search) !==
            JSON.stringify(expandedPlan.generation.search) ||
        JSON.stringify(initialPlan.generation.toolIntent) !==
            JSON.stringify(expandedPlan.generation.toolIntent)
    );
};

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
    correctionCodes: string[];
} => {
    const reasoningSuffixes: string[] = [];
    const correctionCodes: string[] = [];
    const baseGeneration: ChatGenerationPlan = {
        reasoningEffort: normalizeReasoningEffort(candidate?.reasoningEffort),
        verbosity: normalizeVerbosity(candidate?.verbosity),
    };
    const normalizedTemperament = normalizeTemperament(candidate?.temperament);
    if (normalizedTemperament) {
        baseGeneration.temperament = normalizedTemperament;
    }
    const normalizedToolIntent = normalizeToolIntent(candidate?.toolIntent);
    if (normalizedToolIntent) {
        baseGeneration.toolIntent = normalizedToolIntent;
    } else if (candidate?.toolIntent !== undefined) {
        correctionCodes.push('tool_intent_invalid');
    }

    if (!candidate?.search) {
        return {
            generation: baseGeneration,
            correctionCodes,
            ...(reasoningSuffixes.length > 0 && {
                reasoningSuffix: reasoningSuffixes.join(' '),
            }),
        };
    }

    const rawQuery =
        typeof candidate.search.query === 'string'
            ? candidate.search.query.trim()
            : '';
    if (!rawQuery) {
        correctionCodes.push('search_query_invalid');
        if (
            !reasoning.includes('search was disabled safely') &&
            !reasoningSuffixes.some((suffix) =>
                suffix.includes('search was disabled safely')
            )
        ) {
            reasoningSuffixes.push(
                'The planner requested search without a usable query, so search was disabled safely.'
            );
        }
        return {
            generation: baseGeneration,
            correctionCodes,
            ...(reasoningSuffixes.length > 0 && {
                reasoningSuffix: reasoningSuffixes.join(' '),
            }),
        };
    }

    const searchIntent = normalizeSearchIntent(candidate.search.intent);
    const repoHints =
        searchIntent === 'repo_explainer'
            ? normalizeRepoHints(candidate.search.repoHints)
            : undefined;
    const mergedTopicHints = normalizeTopicHints([
        ...normalizeTopicHints(candidate.search.topicHints),
        ...(repoHints ?? []),
    ]);

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
                ...(mergedTopicHints.length > 0
                    ? { topicHints: mergedTopicHints }
                    : {}),
            },
        },
        correctionCodes,
        ...(reasoningSuffixes.length > 0 && {
            reasoningSuffix: reasoningSuffixes.join(' '),
        }),
    };
};

/**
 * Converts raw planner JSON into a fully validated internal ChatPlan.
 */
const normalizePlan = (
    request: PostChatRequest,
    candidate: unknown
): PlannerNormalizationResult => {
    const fallbackPlan = buildFallbackPlan(
        request,
        'Planner returned an invalid or incomplete decision.'
    );
    const contractAssessment = assessPlannerOutputContract(candidate);
    const buildNormalizationResult = (input: {
        plan: ChatPlan;
        fallbackTier: PlannerFallbackTier;
        correctionCodes: string[];
        contextNeed: PlannerContextNeed;
        contextTier: PlannerContextTier;
        contractAssessment: PlannerContractAssessment;
    }): PlannerNormalizationResult => {
        const rawToolIntentValue =
            isPlannerCandidate(candidate) && candidate.toolIntent !== undefined
                ? candidate.toolIntent
                : undefined;
        const rawToolIntentPresent = rawToolIntentValue !== undefined;
        const rawToolIntentName =
            rawToolIntentPresent &&
            typeof rawToolIntentValue === 'object' &&
            rawToolIntentValue !== null &&
            !Array.isArray(rawToolIntentValue) &&
            typeof (rawToolIntentValue as Record<string, unknown>).toolName ===
                'string'
                ? String(
                      (rawToolIntentValue as Record<string, unknown>).toolName
                  )
                : undefined;
        const normalizedToolIntent = input.plan.generation.toolIntent;
        const normalizedToolIntentPresent = normalizedToolIntent !== undefined;
        const normalizedToolIntentName = normalizedToolIntent?.toolName;
        const toolIntentRejected =
            rawToolIntentPresent && !normalizedToolIntentPresent;
        const toolIntentRejectionReasons = toolIntentRejected
            ? input.correctionCodes.filter(
                  (code) =>
                      code === 'tool_intent_invalid' ||
                      code === 'out_of_contract_fields_ignored' ||
                      code === 'authority_fields_ignored'
              )
            : [];
        const hasPartialSignals =
            input.correctionCodes.length > 0 ||
            input.contractAssessment.outOfContractFields.length > 0 ||
            input.contractAssessment.authorityFieldAttempts.length > 0;
        return {
            plan: input.plan,
            fallbackTier: input.fallbackTier,
            correctionCodes: input.correctionCodes,
            contextNeed: input.contextNeed,
            contextTier: input.contextTier,
            applyOutcome:
                input.fallbackTier === 'safe_default_plan'
                    ? 'rejected'
                    : hasPartialSignals
                      ? 'partially_applied'
                      : 'accepted',
            outOfContractFields: input.contractAssessment.outOfContractFields,
            authorityFieldAttempts:
                input.contractAssessment.authorityFieldAttempts,
            diagnostics: {
                rawToolIntentPresent,
                ...(rawToolIntentName !== undefined && { rawToolIntentName }),
                normalizedToolIntentPresent,
                ...(normalizedToolIntentName !== undefined && {
                    normalizedToolIntentName,
                }),
                toolIntentRejected,
                toolIntentRejectionReasons,
            },
        };
    };

    if (!isPlannerCandidate(candidate)) {
        return buildNormalizationResult({
            plan: {
                ...fallbackPlan,
                reasoning:
                    `${fallbackPlan.reasoning} Planner output was not an object, so the backend fell back safely.`.trim(),
            },
            fallbackTier: 'safe_default_plan',
            correctionCodes: ['candidate_not_object'],
            contextNeed: 'sufficient',
            contextTier: 'current_window',
            contractAssessment,
        });
    }

    const correctionCodes: string[] = [];
    const contextNeed = normalizePlannerContextNeed(candidate.contextNeed);
    const contextTier = normalizePlannerContextTier(candidate.contextTier);
    const capabilities = request.capabilities;
    const rawRequestedCapabilityProfile =
        typeof candidate.requestedCapabilityProfile === 'string'
            ? candidate.requestedCapabilityProfile.trim()
            : '';
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
        requestedCapabilityProfile: normalizeRequestedCapabilityProfile(
            'generation',
            candidate.requestedCapabilityProfile
        ),
        safetyTier: normalizeSafetyTier(candidate.safetyTier),
        reasoning:
            typeof candidate.reasoning === 'string' &&
            candidate.reasoning.trim()
                ? candidate.reasoning.trim()
                : fallbackPlan.reasoning,
        generation: fallbackPlan.generation,
    };
    if (contractAssessment.outOfContractFields.length > 0) {
        correctionCodes.push('out_of_contract_fields_ignored');
    }
    if (contractAssessment.authorityFieldAttempts.length > 0) {
        correctionCodes.push('authority_fields_ignored');
        normalizedPlan.reasoning =
            `${normalizedPlan.reasoning} Out-of-contract authority fields were ignored, so planner output could not mutate backend authority controls.`.trim();
    }

    const normalizedGeneration = normalizeGeneration(
        candidate.generation,
        normalizedPlan.reasoning
    );
    normalizedPlan.generation = normalizedGeneration.generation;
    correctionCodes.push(...normalizedGeneration.correctionCodes);
    if (normalizedGeneration.reasoningSuffix) {
        normalizedPlan.reasoning =
            `${normalizedPlan.reasoning} ${normalizedGeneration.reasoningSuffix}`.trim();
    }

    if (normalizedPlan.action === 'react') {
        if (!capabilities?.canReact) {
            return buildNormalizationResult({
                plan: {
                    ...fallbackPlan,
                    reasoning:
                        `${normalizedPlan.reasoning} React was not allowed by caller capabilities, so the planner fell back safely.`.trim(),
                },
                fallbackTier: 'safe_default_plan',
                correctionCodes: [...correctionCodes, 'react_not_allowed'],
                contextNeed,
                contextTier,
                contractAssessment,
            });
        }

        if (
            typeof candidate.reaction !== 'string' ||
            !candidate.reaction.trim()
        ) {
            return buildNormalizationResult({
                plan: {
                    ...fallbackPlan,
                    reasoning:
                        `${normalizedPlan.reasoning} React action was missing emoji, so the planner fell back safely.`.trim(),
                },
                fallbackTier: 'safe_default_plan',
                correctionCodes: [...correctionCodes, 'react_missing_emoji'],
                contextNeed,
                contextTier,
                contractAssessment,
            });
        }
        const trimmedReaction = candidate.reaction.trim();
        if (!isValidReactionEmoji(trimmedReaction)) {
            return buildNormalizationResult({
                plan: {
                    ...fallbackPlan,
                    reasoning:
                        `${normalizedPlan.reasoning} React action was not a valid emoji token, so the planner fell back safely.`.trim(),
                },
                fallbackTier: 'safe_default_plan',
                correctionCodes: [...correctionCodes, 'react_invalid_emoji'],
                contextNeed,
                contextTier,
                contractAssessment,
            });
        }

        return buildNormalizationResult({
            plan: {
                ...normalizedPlan,
                reaction: trimmedReaction,
                generation: {
                    ...normalizedPlan.generation,
                    search: undefined,
                    toolIntent: undefined,
                },
            },
            fallbackTier:
                correctionCodes.length > 0 ? 'field_corrections' : 'none',
            correctionCodes,
            contextNeed,
            contextTier,
            contractAssessment,
        });
    }

    if (normalizedPlan.action === 'ignore') {
        return buildNormalizationResult({
            plan: {
                ...normalizedPlan,
                modality: 'text',
                generation: {
                    ...normalizedPlan.generation,
                    search: undefined,
                    toolIntent: undefined,
                },
            },
            fallbackTier:
                correctionCodes.length > 0 ? 'field_corrections' : 'none',
            correctionCodes,
            contextNeed,
            contextTier,
            contractAssessment,
        });
    }

    if (normalizedPlan.action === 'image') {
        if (!capabilities?.canGenerateImages) {
            return buildNormalizationResult({
                plan: {
                    ...fallbackPlan,
                    reasoning:
                        `${normalizedPlan.reasoning} Image generation was not allowed by caller capabilities, so the planner fell back safely.`.trim(),
                },
                fallbackTier: 'safe_default_plan',
                correctionCodes: [...correctionCodes, 'image_not_allowed'],
                contextNeed,
                contextTier,
                contractAssessment,
            });
        }

        const imageRequest = normalizeImageRequest(candidate.imageRequest);
        if (!imageRequest) {
            return buildNormalizationResult({
                plan: {
                    ...fallbackPlan,
                    reasoning:
                        `${normalizedPlan.reasoning} Image action was missing a valid image request, so the planner fell back safely.`.trim(),
                },
                fallbackTier: 'safe_default_plan',
                correctionCodes: [...correctionCodes, 'image_request_invalid'],
                contextNeed,
                contextTier,
                contractAssessment,
            });
        }

        return buildNormalizationResult({
            plan: {
                ...normalizedPlan,
                modality: 'text',
                imageRequest,
                generation: {
                    ...normalizedPlan.generation,
                    search: undefined,
                    toolIntent: undefined,
                },
            },
            fallbackTier:
                correctionCodes.length > 0 ? 'field_corrections' : 'none',
            correctionCodes,
            contextNeed,
            contextTier,
            contractAssessment,
        });
    }

    if (!normalizedPlan.requestedCapabilityProfile) {
        return buildNormalizationResult({
            plan: {
                ...fallbackPlan,
                action: 'message',
                modality: normalizedPlan.modality,
                safetyTier: normalizedPlan.safetyTier,
                reasoning:
                    `${normalizedPlan.reasoning} Planner omitted required requestedCapabilityProfile for message action, so the backend fell back safely.`.trim(),
            },
            fallbackTier: 'safe_default_plan',
            correctionCodes: [
                ...correctionCodes,
                rawRequestedCapabilityProfile
                    ? 'requested_capability_profile_invalid'
                    : 'requested_capability_profile_missing',
            ],
            contextNeed,
            contextTier,
            contractAssessment,
        });
    }

    if (!normalizedPlan.generation.temperament) {
        return buildNormalizationResult({
            plan: {
                ...fallbackPlan,
                action: 'message',
                modality: normalizedPlan.modality,
                safetyTier: normalizedPlan.safetyTier,
                reasoning:
                    `${normalizedPlan.reasoning} Planner omitted required TRACE temperament, so the backend fell back safely.`.trim(),
            },
            fallbackTier: 'safe_default_plan',
            correctionCodes: [...correctionCodes, 'temperament_missing'],
            contextNeed,
            contextTier,
            contractAssessment,
        });
    }

    return buildNormalizationResult({
        plan: normalizedPlan,
        fallbackTier: correctionCodes.length > 0 ? 'field_corrections' : 'none',
        correctionCodes,
        contextNeed,
        contextTier,
        contractAssessment,
    });
};

/**
 * Creates the planner wrapper used by chat orchestration.
 *
 * This code runs the planner, cleans up its output, and falls back when the
 * model returns something unusable. It does not get the last word on tools,
 * profiles, or the final response.
 */
export const createChatPlanner = ({
    executePlanner,
    executePlannerStructured,
    allowTextJsonCompatibilityFallback = false,
    defaultModel = runtimeConfig.openai.defaultModel,
    structuredExecutionTimeoutMs = runtimeConfig.openai.requestTimeoutMs,
    availableCapabilityProfiles = [],
    recordUsage = recordBackendLLMUsage,
}: CreateChatPlannerOptions) => {
    if (!executePlanner && !executePlannerStructured) {
        throw new Error(
            'createChatPlanner requires at least one executor (structured or text JSON).'
        );
    }

    // Keep this input small. The planner needs enough context to choose well,
    // but not the whole profile catalog or backend config.
    const plannerCapabilityContext =
        availableCapabilityProfiles.length > 0
            ? JSON.stringify(
                  availableCapabilityProfiles.map((profile) => ({
                      id: profile.id,
                      description: profile.description,
                  }))
              )
            : '[]';

    const planChat = async (
        request: PostChatRequest,
        invocationContext?: ChatPlannerInvocationContext
    ): Promise<ChatPlannerResult> => {
        const plannerStartedAt = Date.now();
        if (!isWorkflowOwnedPlannerInvocation(invocationContext)) {
            logger.warn(
                'chat planner invocation rejected because workflow-owned context and purpose were not provided; using safe fallback',
                buildPlannerInvocationRejectionLogMeta({
                    request,
                    invocationContext,
                })
            );
            return {
                plan: buildFallbackPlan(
                    request,
                    'Planner invocation was outside workflow-owned boundaries, so the backend used a safe fallback.'
                ),
                execution: {
                    status: 'skipped',
                    reasonCode: 'planner_runtime_error',
                    durationMs: Date.now() - plannerStartedAt,
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'fallback',
                },
                diagnostics: {
                    rawToolIntentPresent: false,
                    normalizedToolIntentPresent: false,
                    toolIntentRejected: false,
                    toolIntentRejectionReasons: [],
                },
            };
        }

        let plannerMode: ChatPlannerExecutionMode = executePlannerStructured
            ? 'structured'
            : 'text_json';
        let plannerResponseText: string | undefined;
        let plannerStructuredArguments: string | undefined;
        const plannerPrompt = renderPrompt('chat.planner.system').content;
        const requestSummary = summarizeRequest(request);
        const plannerMessages = buildPlannerMessages({
            plannerPrompt,
            plannerProfileContext: plannerCapabilityContext,
            requestSummary,
            request,
            contextTier: 'current_window',
        });

        const requestPayload: ChatPlannerExecutionRequest = {
            messages: plannerMessages,
            model: defaultModel,
            maxOutputTokens: 1200,
            reasoningEffort: 'low',
        };

        const recordPlannerUsage = (
            usageModel: string,
            usage?: GenerationUsage
        ) => {
            const promptTokens = usage?.promptTokens ?? 0;
            const completionTokens = usage?.completionTokens ?? 0;
            const totalTokens =
                usage?.totalTokens ?? promptTokens + completionTokens;
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
        };

        const runExpandedTextJsonAttempt = async (
            contextTier: PlannerContextTier
        ): Promise<PlannerNormalizationResult | null> => {
            if (!executePlanner) {
                return null;
            }

            const expandedMessages = buildPlannerMessages({
                plannerPrompt,
                plannerProfileContext: plannerCapabilityContext,
                requestSummary,
                request,
                contextTier,
            });
            const expandedRequestPayload: ChatPlannerExecutionRequest = {
                messages: expandedMessages,
                model: defaultModel,
                maxOutputTokens: 1200,
                reasoningEffort: 'low',
            };
            const expandedResponse = await executePlanner(
                expandedRequestPayload
            );
            plannerResponseText = expandedResponse.text;
            recordPlannerUsage(
                expandedResponse.model || defaultModel,
                expandedResponse.usage
            );
            const expandedCandidate = parsePlannerCandidateFromTextJson(
                expandedResponse.text
            );
            const expandedNormalization = normalizePlan(
                request,
                expandedCandidate
            );
            logPlannerOutputIngestion({
                normalization: expandedNormalization,
                mode: 'text_json',
                attempt: 'expanded',
                request,
            });
            return expandedNormalization;
        };

        const resolveAdaptivePlan = async (
            initialNormalization: PlannerNormalizationResult,
            initialExecution: {
                status: ChatPlannerExecution['status'];
                reasonCode?: ExecutionReasonCode;
            }
        ): Promise<ChatPlannerResult> => {
            const initialAttemptContractType = plannerMode;
            const baseExecution: ChatPlannerExecution = {
                ...initialExecution,
                durationMs: Date.now() - plannerStartedAt,
                plannerAttemptIndex: 1,
                contextTier: 'current_window',
                selectedAttempt: 'initial',
                purpose: invocationContext.purpose,
                contractType: initialAttemptContractType,
            };

            if (
                initialExecution.status !== 'executed' ||
                initialNormalization.contextNeed !== 'needs_more_context'
            ) {
                return {
                    plan: initialNormalization.plan,
                    execution: baseExecution,
                    diagnostics: initialNormalization.diagnostics,
                };
            }

            const expandedTier =
                initialNormalization.contextTier === 'current_window'
                    ? 'expanded_recent'
                    : initialNormalization.contextTier;
            if (!hasContextExpansionBudget(request, expandedTier)) {
                return {
                    plan: initialNormalization.plan,
                    execution: {
                        ...baseExecution,
                        contextReasonCode: 'planner_context_budget_exhausted',
                    },
                    diagnostics: initialNormalization.diagnostics,
                };
            }

            try {
                const expandedNormalization =
                    await runExpandedTextJsonAttempt(expandedTier);
                if (!expandedNormalization) {
                    return {
                        plan: initialNormalization.plan,
                        execution: {
                            ...baseExecution,
                            contextReasonCode:
                                'planner_expansion_invalid_fallback_initial',
                        },
                        diagnostics: initialNormalization.diagnostics,
                    };
                }

                if (
                    expandedNormalization.fallbackTier === 'safe_default_plan'
                ) {
                    return {
                        plan: initialNormalization.plan,
                        execution: {
                            ...baseExecution,
                            plannerAttemptIndex: 2,
                            contextReasonCode:
                                'planner_expansion_invalid_fallback_initial',
                        },
                        diagnostics: initialNormalization.diagnostics,
                    };
                }

                const shouldAdoptExpandedPlan =
                    expandedNormalization.contextNeed === 'sufficient' ||
                    hasMaterialPlanChange(
                        initialNormalization.plan,
                        expandedNormalization.plan
                    );
                if (shouldAdoptExpandedPlan) {
                    return {
                        plan: expandedNormalization.plan,
                        execution: {
                            status: 'executed',
                            durationMs: Date.now() - plannerStartedAt,
                            plannerAttemptIndex: 2,
                            contextTier: expandedTier,
                            selectedAttempt: 'expanded',
                            contextReasonCode: 'planner_context_expanded',
                            purpose: invocationContext.purpose,
                            contractType: 'text_json',
                        },
                        diagnostics: expandedNormalization.diagnostics,
                    };
                }

                return {
                    plan: initialNormalization.plan,
                    execution: {
                        ...baseExecution,
                        plannerAttemptIndex: 2,
                        contextReasonCode: 'planner_expansion_rejected',
                    },
                    diagnostics: initialNormalization.diagnostics,
                };
            } catch (error) {
                const timeoutExpansion =
                    error instanceof Error && /timed out/i.test(error.message);
                return {
                    plan: initialNormalization.plan,
                    execution: {
                        ...baseExecution,
                        plannerAttemptIndex: 2,
                        contextReasonCode: timeoutExpansion
                            ? 'planner_context_timeout_fail_open'
                            : 'planner_expansion_invalid_fallback_initial',
                    },
                    diagnostics: initialNormalization.diagnostics,
                };
            }
        };

        try {
            if (executePlannerStructured) {
                const structuredAbortContext = createTimeoutSignal({
                    timeoutMs: structuredExecutionTimeoutMs,
                    callerSignal: requestPayload.signal,
                });
                let structuredResponse: ChatPlannerStructuredExecutionResult;
                try {
                    structuredResponse = await executePlannerStructured({
                        ...requestPayload,
                        signal: structuredAbortContext.signal,
                    });
                } catch (structuredError) {
                    if (
                        structuredError instanceof Error &&
                        structuredError.name === 'AbortError' &&
                        structuredAbortContext.timedOut()
                    ) {
                        throw new Error(
                            `Planner structured call timed out after ${structuredExecutionTimeoutMs}ms`,
                            { cause: structuredError }
                        );
                    }

                    throw structuredError;
                } finally {
                    structuredAbortContext.cleanup();
                }
                plannerStructuredArguments = structuredResponse.rawArguments;
                recordPlannerUsage(
                    structuredResponse.model || defaultModel,
                    structuredResponse.usage
                );
                const normalization = normalizePlan(
                    request,
                    structuredResponse.decision
                );
                logPlannerOutputIngestion({
                    normalization,
                    mode: 'structured',
                    attempt: 'initial',
                    request,
                });
                if (normalization.fallbackTier === 'safe_default_plan') {
                    logPlannerPolicyInvalidFallback({
                        normalization,
                        mode: 'structured',
                        request,
                        plannerStructuredArguments,
                        plannerResponseText,
                    });
                    return resolveAdaptivePlan(normalization, {
                        status: 'failed',
                        reasonCode: 'planner_invalid_output',
                    });
                }

                return resolveAdaptivePlan(normalization, {
                    status: 'executed',
                });
            }

            if (!executePlanner) {
                throw new Error('Text JSON planner executor is not available.');
            }

            plannerMode = 'text_json';
            const plannerResponse = await executePlanner(requestPayload);
            plannerResponseText = plannerResponse.text;
            recordPlannerUsage(
                plannerResponse.model || defaultModel,
                plannerResponse.usage
            );
            const parsed = parsePlannerCandidateFromTextJson(
                plannerResponse.text
            );
            const normalization = normalizePlan(request, parsed);
            logPlannerOutputIngestion({
                normalization,
                mode: 'text_json',
                attempt: 'initial',
                request,
            });

            /*
            if (isDevelopment()) {
                logger.debug(
                    `Chat planner decision summary: ${requestSummary}`
                );
                logger.debug(
                    `Chat planner chose action=${normalizedPlan.action} modality=${normalizedPlan.modality} safetyTier=${normalizedPlan.safetyTier}`
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
            if (normalization.fallbackTier === 'safe_default_plan') {
                logPlannerPolicyInvalidFallback({
                    normalization,
                    mode: 'text_json',
                    request,
                    plannerStructuredArguments,
                    plannerResponseText,
                });
            }

            return resolveAdaptivePlan(normalization, {
                status:
                    normalization.fallbackTier === 'safe_default_plan'
                        ? 'failed'
                        : 'executed',
                ...(normalization.fallbackTier === 'safe_default_plan'
                    ? {
                          reasonCode: 'planner_invalid_output' as const,
                      }
                    : {}),
            });
        } catch (error) {
            let resolvedError: unknown = error;
            const shouldAttemptCompatibilityFallback =
                executePlannerStructured &&
                executePlanner &&
                (allowTextJsonCompatibilityFallback ||
                    error instanceof SyntaxError ||
                    (error instanceof Error &&
                        /Failed structured planner argument parsing/i.test(
                            error.message
                        )));
            if (shouldAttemptCompatibilityFallback) {
                logger.warn(
                    `chat planner structured execution failed; attempting text JSON compatibility fallback. error=${error instanceof Error ? error.message : String(error)}`,
                    {
                        event: 'chat.planner.compatibility_fallback',
                        plannerMode: 'structured',
                        fallbackFrom: 'structured',
                        fallbackTo: 'text_json',
                        failureClass:
                            error instanceof SyntaxError
                                ? 'schema_invalid'
                                : 'runtime_error',
                        errorName:
                            error instanceof Error ? error.name : undefined,
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        fallbackPolicy: allowTextJsonCompatibilityFallback
                            ? 'env_enabled'
                            : error instanceof SyntaxError
                              ? 'syntax_error_auto'
                              : 'parse_error_auto',
                    }
                );
                try {
                    plannerMode = 'text_json';
                    const textJsonResponse =
                        await executePlanner(requestPayload);
                    plannerResponseText = textJsonResponse.text;
                    recordPlannerUsage(
                        textJsonResponse.model || defaultModel,
                        textJsonResponse.usage
                    );
                    const parsed = parsePlannerCandidateFromTextJson(
                        textJsonResponse.text
                    );
                    const normalization = normalizePlan(request, parsed);
                    logPlannerOutputIngestion({
                        normalization,
                        mode: 'text_json',
                        attempt: 'initial',
                        request,
                    });
                    if (normalization.fallbackTier === 'safe_default_plan') {
                        logPlannerPolicyInvalidFallback({
                            normalization,
                            mode: 'text_json',
                            request,
                            plannerStructuredArguments,
                            plannerResponseText,
                        });
                    }
                    return resolveAdaptivePlan(normalization, {
                        status:
                            normalization.fallbackTier === 'safe_default_plan'
                                ? 'failed'
                                : 'executed',
                        ...(normalization.fallbackTier === 'safe_default_plan'
                            ? {
                                  reasonCode: 'planner_invalid_output' as const,
                              }
                            : {}),
                    });
                } catch (textJsonError) {
                    resolvedError = textJsonError;
                }
            }

            const fallbackPlan = buildFallbackPlan(
                request,
                'Planner failed, so the backend used a safe fallback.'
            );
            // Parse failures are explicitly separated from runtime failures so
            // downstream metadata and logs can distinguish prompt/schema drift
            // from upstream service instability.
            const reasonCode: ExecutionReasonCode =
                resolvedError instanceof SyntaxError
                    ? 'planner_invalid_output'
                    : 'planner_runtime_error';
            logger.warn(
                `chat planner failed; using fallback plan. reasonCode=${reasonCode} error=${resolvedError instanceof Error ? resolvedError.message : String(resolvedError)}`,
                {
                    event: 'chat.planner.fallback',
                    plannerMode,
                    fallbackFrom: plannerMode,
                    fallbackTo: 'safe_default_plan',
                    fallbackTier: 'safe_default_plan',
                    reasonCode,
                    failureClass:
                        reasonCode === 'planner_invalid_output'
                            ? 'schema_invalid'
                            : 'runtime_error',
                    fallbackAction: fallbackPlan.action,
                    triggerKind: request.trigger.kind,
                    surface: request.surface,
                    errorName:
                        resolvedError instanceof Error
                            ? resolvedError.name
                            : undefined,
                    errorMessage:
                        resolvedError instanceof Error
                            ? resolvedError.message
                            : String(resolvedError),
                    plannerResponsePreviewPresent:
                        resolvedError instanceof SyntaxError &&
                        Boolean(
                            plannerStructuredArguments || plannerResponseText
                        ),
                    plannerStructuredPreviewPresent:
                        resolvedError instanceof SyntaxError &&
                        plannerStructuredArguments !== undefined,
                    plannerStructuredPreviewLength:
                        resolvedError instanceof SyntaxError
                            ? plannerStructuredArguments?.length
                            : undefined,
                    plannerResponseTextLength:
                        resolvedError instanceof SyntaxError
                            ? plannerResponseText?.length
                            : undefined,
                }
            );
            return {
                plan: fallbackPlan,
                execution: {
                    status: 'failed',
                    reasonCode,
                    durationMs: Date.now() - plannerStartedAt,
                    purpose: invocationContext.purpose,
                    contractType: 'fallback',
                },
                diagnostics: {
                    rawToolIntentPresent: false,
                    normalizedToolIntentPresent: false,
                    toolIntentRejected: false,
                    toolIntentRejectionReasons: [],
                },
            };
        }
    };

    return {
        planChat,
    };
};
