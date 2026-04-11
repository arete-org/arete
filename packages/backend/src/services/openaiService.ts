/**
 * @description: Minimal OpenAI client wrapper and response metadata builder for the chat API.
 * @footnote-scope: utility
 * @footnote-module: ChatOpenAIService
 * @footnote-risk: high - Incorrect handling can degrade responses, retrieval quality, or metadata integrity.
 * @footnote-ethics: high - Misreported provenance or dropped retrieval harms trust and transparency.
 */
import crypto from 'node:crypto';
import type {
    GenerationSearchContextSize,
    GenerationSearchIntent,
    GenerationRequest,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type {
    Citation,
    ExecutionEvent,
    ExecutionReasonCode,
    ExecutionStatus,
    EvaluatorOutcome,
    EvaluatorExecutionReasonCode,
    GenerationExecutionReasonCode,
    PlannerExecutionApplyOutcome,
    PlannerExecutionContractType,
    PlannerExecutionPurpose,
    PartialResponseTemperament,
    PlannerExecutionReasonCode,
    Provenance,
    ResponseMetadata,
    SafetyTier,
    SteerabilityControlId,
    ToolExecutionContext,
    ToolInvocationReasonCode,
    TraceAxisScore,
    WorkflowRecord,
} from '@footnote/contracts/ethics-core';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { buildWebSearchInstruction } from './chatGenerationHints.js';
import {
    classifyProvenanceWithSignals,
    deriveRetrievedChips,
    resolveTradeoffCount,
} from './responseMetadataHeuristics.js';

type OpenAIUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
};

type AssistantUsage = {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
};

type AssistantResponseMetadata = {
    model: string;
    usage?: AssistantUsage;
    finishReason?: string;
    reasoningEffort?: string;
    verbosity?: string;
    provenance?: Provenance;
    tradeoffCount?: number;
    citations?: Citation[];
    evidenceScore?: TraceAxisScore;
    freshnessScore?: TraceAxisScore;
};

type OpenAIResponseMetadata = {
    model: AssistantResponseMetadata['model'];
    usage?: OpenAIUsage;
    finishReason?: AssistantResponseMetadata['finishReason'];
    reasoningEffort?: AssistantResponseMetadata['reasoningEffort'];
    verbosity?: AssistantResponseMetadata['verbosity'];
    provenance?: AssistantResponseMetadata['provenance'];
    tradeoffCount?: AssistantResponseMetadata['tradeoffCount'];
    citations?: AssistantResponseMetadata['citations'];
    evidenceScore?: AssistantResponseMetadata['evidenceScore'];
    freshnessScore?: AssistantResponseMetadata['freshnessScore'];
};

type GenerateResponseResult = {
    normalizedText: string;
    metadata: OpenAIResponseMetadata;
};

type GenerateResponseOptions = Pick<
    GenerationRequest,
    'maxOutputTokens' | 'reasoningEffort' | 'verbosity' | 'search' | 'signal'
>;

interface OpenAIService {
    generateResponse(
        model: string,
        messages: RuntimeMessage[],
        options?: GenerateResponseOptions
    ): Promise<GenerateResponseResult>;
}

type ResponsesApiInputMessage = {
    role: string;
    type: 'message';
    content:
        | string
        | Array<{
              type: 'input_text';
              text: string;
          }>;
};

type ResponsesApiOutputText = {
    type?: string;
    text?: string;
    annotations?: Array<{
        type: string;
        url?: string;
        title?: string;
        start_index: number;
        end_index: number;
    }>;
};

type ResponsesApiOutputItem = {
    type?: string;
    role?: string;
    content?: ResponsesApiOutputText[];
    finish_reason?: string;
};

type ResponsesApiTool =
    | {
          type: 'web_search';
          search_context_size?: 'low' | 'medium' | 'high';
      }
    | {
          type: 'function';
          name: string;
          description?: string;
          parameters?: Record<string, unknown>;
      };

const TRACE_AXIS_KEYS = [
    'tightness',
    'rationale',
    'attribution',
    'caution',
    'extent',
] as const;

/**
 * Runtime guard for TRACE axis chip values.
 */
const isTraceAxisScore = (value: unknown): value is TraceAxisScore =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5;

/**
 * Keeps only valid TRACE planner axes so downstream metadata stays schema-safe.
 */
const normalizePlannerTemperament = (
    temperament: PartialResponseTemperament | undefined
): PartialResponseTemperament | undefined => {
    if (!temperament) {
        return undefined;
    }

    const normalized: PartialResponseTemperament = {};
    for (const axis of TRACE_AXIS_KEYS) {
        const score = temperament[axis];
        if (isTraceAxisScore(score)) {
            normalized[axis] = score;
        }
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
};

/**
 * Maps planner reasoning effort to a valid Responses API setting.
 */
const normalizeReasoningEffort = (
    value: GenerateResponseOptions['reasoningEffort']
): NonNullable<GenerateResponseOptions['reasoningEffort']> => {
    if (value === 'minimal') {
        return 'low';
    }

    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

/**
 * Maps planner verbosity to a valid Responses API setting.
 */
const normalizeVerbosity = (
    value: GenerateResponseOptions['verbosity']
): NonNullable<GenerateResponseOptions['verbosity']> => {
    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

/**
 * Extracts URL citations directly from OpenAI output annotations.
 * This is the hard-cutover path for provenance citations (no footer parsing).
 */
const extractCitationsFromOutputItems = (
    outputItems: ResponsesApiOutputItem[]
): Citation[] => {
    const citations: Citation[] = [];
    const seenCitations = new Set<string>();

    for (const item of outputItems) {
        if (
            item.type !== 'message' ||
            item.role !== 'assistant' ||
            !Array.isArray(item.content)
        ) {
            continue;
        }

        for (const contentItem of item.content) {
            if (
                contentItem.type !== 'output_text' ||
                !contentItem.text ||
                !Array.isArray(contentItem.annotations)
            ) {
                continue;
            }

            for (const annotation of contentItem.annotations) {
                if (
                    annotation.type !== 'url_citation' ||
                    typeof annotation.url !== 'string'
                ) {
                    continue;
                }

                let normalizedUrl: string;
                try {
                    normalizedUrl = new URL(annotation.url).toString();
                } catch {
                    continue;
                }

                const normalizedTitle =
                    typeof annotation.title === 'string' &&
                    annotation.title.trim().length > 0
                        ? annotation.title.trim()
                        : 'Source';
                const dedupeKey = `${normalizedUrl}::${normalizedTitle}`;
                if (seenCitations.has(dedupeKey)) {
                    continue;
                }

                seenCitations.add(dedupeKey);
                const snippet =
                    Number.isInteger(annotation.start_index) &&
                    Number.isInteger(annotation.end_index) &&
                    annotation.start_index >= 0 &&
                    annotation.end_index > annotation.start_index
                        ? contentItem.text.slice(
                              annotation.start_index,
                              annotation.end_index
                          )
                        : undefined;
                citations.push({
                    title: normalizedTitle,
                    url: normalizedUrl,
                    ...(snippet && snippet.trim().length > 0
                        ? { snippet }
                        : {}),
                });
            }
        }
    }

    return citations;
};

/**
 * Numeric markdown footnote markers are not useful user-facing titles.
 */
const normalizeFallbackCitationTitle = (label: string): string => {
    const normalizedLabel = label.trim();

    return /^\d+$/.test(normalizedLabel) ? 'Source' : normalizedLabel;
};

/**
 * Recovers visible markdown links when retrieved output lacks structured
 * `url_citation` annotations.
 *
 * This intentionally stays narrow: only markdown links are preserved here, and
 * only for retrieval-backed responses. Bare URLs are out of scope for this
 * fallback because they are more likely to capture incidental text.
 */
const extractMarkdownLinkCitations = (text: string): Citation[] => {
    const citations: Citation[] = [];
    const seenUrls = new Set<string>();
    const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

    for (const match of text.matchAll(markdownLinkPattern)) {
        const rawLabel = match[1];
        const rawUrl = match[2];
        if (
            typeof rawLabel !== 'string' ||
            rawLabel.trim().length === 0 ||
            typeof rawUrl !== 'string'
        ) {
            continue;
        }

        let normalizedUrl: string;
        try {
            const parsedUrl = new URL(rawUrl);
            if (
                parsedUrl.protocol !== 'http:' &&
                parsedUrl.protocol !== 'https:'
            ) {
                continue;
            }
            normalizedUrl = parsedUrl.toString();
        } catch {
            continue;
        }

        if (seenUrls.has(normalizedUrl)) {
            continue;
        }

        seenUrls.add(normalizedUrl);
        citations.push({
            title: normalizeFallbackCitationTitle(rawLabel),
            url: normalizedUrl,
        });
    }

    return citations;
};

/**
 * Detects whether the model output includes an executed web search tool call.
 * This is stronger evidence than planner intent alone.
 */
const hasWebSearchCallInOutputItems = (
    outputItems: ResponsesApiOutputItem[]
): boolean => outputItems.some((item) => item.type === 'web_search_call');

/**
 * Converts internal role/content messages into Responses API input messages.
 */
const buildInputMessage = (
    role: string,
    text: string
): ResponsesApiInputMessage => ({
    role,
    type: 'message',
    content: role === 'assistant' ? text : [{ type: 'input_text', text }],
});

type RequestAbortContext = {
    signal: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
};

/**
 * Merges the backend timeout budget with an optional caller cancellation signal.
 */
const createRequestAbortContext = (
    timeoutMs: number,
    externalSignal?: AbortSignal
): RequestAbortContext => {
    const controller = new AbortController();
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    const handleExternalAbort = (): void => {
        controller.abort();
    };

    if (externalSignal) {
        if (externalSignal.aborted) {
            handleExternalAbort();
        } else {
            externalSignal.addEventListener('abort', handleExternalAbort, {
                once: true,
            });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutHandle);
            if (externalSignal) {
                externalSignal.removeEventListener(
                    'abort',
                    handleExternalAbort
                );
            }
        },
        didTimeout: () => timedOut,
    };
};

class SimpleOpenAIService implements OpenAIService {
    private readonly apiKey: string;
    private readonly requestTimeoutMs: number;
    private readonly retryAttempts: number;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        this.requestTimeoutMs = runtimeConfig.openai.requestTimeoutMs;
        this.retryAttempts = 1;
    }

    async generateResponse(
        model: string,
        messages: RuntimeMessage[],
        options: GenerateResponseOptions = {}
    ): Promise<GenerateResponseResult> {
        const validMessages = messages.filter((message) => {
            if (!message.content || !message.content.trim()) {
                logger.warn(
                    `Filtering out invalid backend chat message with role=${message.role}`
                );
                return false;
            }

            return true;
        });

        const normalizedReasoningEffort = normalizeReasoningEffort(
            options.reasoningEffort
        );
        const normalizedVerbosity = normalizeVerbosity(options.verbosity);
        const hasSearchRequest =
            typeof options.search?.query === 'string' &&
            options.search.query.trim().length > 0;

        if (options.search && !hasSearchRequest) {
            logger.warn(
                'Backend chat requested search without a usable query; falling back to generation without retrieval.'
            );
        }

        const tools: ResponsesApiTool[] = [];
        if (hasSearchRequest && options.search) {
            tools.push({
                type: 'web_search',
                search_context_size: options.search.contextSize,
            });
        }

        const requestInput: ResponsesApiInputMessage[] = [
            ...validMessages.map((message) =>
                buildInputMessage(message.role, message.content)
            ),
            ...(hasSearchRequest && options.search
                ? [
                      buildInputMessage(
                          'system',
                          buildWebSearchInstruction({
                              ...options.search,
                              repoHints: options.search.repoHints ?? [],
                          })
                      ),
                  ]
                : []),
        ];

        const requestBody = JSON.stringify({
            model,
            input: requestInput,
            max_output_tokens: options.maxOutputTokens ?? 4000,
            reasoning: { effort: normalizedReasoningEffort },
            text: { verbosity: normalizedVerbosity },
            ...(tools.length > 0 && { tools }),
        });

        const performRequest = async (attempt: number): Promise<Response> => {
            const abortContext = createRequestAbortContext(
                this.requestTimeoutMs,
                options.signal
            );

            try {
                return await fetch('https://api.openai.com/v1/responses', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: requestBody,
                    signal: abortContext.signal,
                });
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    if (abortContext.didTimeout()) {
                        throw new Error(
                            `OpenAI request timed out after ${this.requestTimeoutMs}ms`,
                            { cause: error }
                        );
                    }

                    throw new Error('OpenAI request was aborted by caller', {
                        cause: error,
                    });
                }

                if (attempt < this.retryAttempts) {
                    const backoffMs = 300 * (attempt + 1);
                    await new Promise((resolve) =>
                        setTimeout(resolve, backoffMs)
                    );
                    return performRequest(attempt + 1);
                }

                throw error;
            } finally {
                abortContext.cleanup();
            }
        };

        let response = await performRequest(0);
        let retryCount = 0;
        while (
            !response.ok &&
            response.status >= 500 &&
            retryCount < this.retryAttempts
        ) {
            const backoffMs = 300 * (retryCount + 1);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            retryCount += 1;
            response = await performRequest(retryCount);
        }

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`OpenAI API error details: ${errorText}`);
            throw new Error(
                `OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`
            );
        }

        const data = (await response.json()) as {
            model?: string;
            usage?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
            };
            output?: ResponsesApiOutputItem[];
            output_text?: string;
        };

        const outputItems = data.output ?? [];
        let rawOutputText = '';
        let finishReason = 'stop';

        for (const item of outputItems) {
            if (
                item.type === 'message' &&
                item.role === 'assistant' &&
                Array.isArray(item.content)
            ) {
                const textContent = item.content.find(
                    (contentItem) => contentItem.type === 'output_text'
                );
                if (textContent?.text) {
                    rawOutputText = textContent.text;
                }
                finishReason = item.finish_reason ?? finishReason;
                break;
            }
        }

        if (!rawOutputText && typeof data.output_text === 'string') {
            rawOutputText = data.output_text;
        }

        // User-facing reply body is model text only; metadata is produced out-of-band.
        const normalizedText = rawOutputText.trimEnd();
        const hasWebSearchCall = hasWebSearchCallInOutputItems(outputItems);
        const citationsFromAnnotations =
            extractCitationsFromOutputItems(outputItems);
        const citations =
            citationsFromAnnotations.length === 0 &&
            hasWebSearchCall &&
            normalizedText.length > 0
                ? extractMarkdownLinkCitations(normalizedText)
                : citationsFromAnnotations;
        const provenance: Provenance =
            citations.length > 0 || hasWebSearchCall ? 'Retrieved' : 'Inferred';

        const assistantMetadata: OpenAIResponseMetadata = {
            model: data.model ?? model,
            usage: {
                prompt_tokens: data.usage?.input_tokens,
                completion_tokens: data.usage?.output_tokens,
                total_tokens:
                    data.usage?.total_tokens ??
                    (data.usage?.input_tokens ?? 0) +
                        (data.usage?.output_tokens ?? 0),
            },
            finishReason,
            reasoningEffort: normalizedReasoningEffort,
            verbosity: normalizedVerbosity,
            provenance,
            citations,
        };

        return {
            normalizedText,
            metadata: assistantMetadata,
        };
    }
}

type ResponseMetadataRetrievalContext = {
    requested: boolean;
    used: boolean;
    intent?: GenerationSearchIntent;
    contextSize?: GenerationSearchContextSize;
};

type ResponseMetadataRuntimeContext = {
    modelVersion: string;
    conversationSnapshot: string;
    totalDurationMs?: number;
    plannerTemperament?: PartialResponseTemperament;
    retrieval?: ResponseMetadataRetrievalContext;
    trustGraphEvidenceAvailable?: boolean;
    trustGraphEvidenceUsed?: boolean;
    executionContext?: {
        planner?: {
            status: ExecutionStatus;
            reasonCode?: ExecutionReasonCode;
            purpose: PlannerExecutionPurpose;
            contractType: PlannerExecutionContractType;
            applyOutcome: PlannerExecutionApplyOutcome;
            mattered: boolean;
            matteredControlIds: SteerabilityControlId[];
            profileId: string;
            originalProfileId?: string;
            effectiveProfileId?: string;
            provider: string;
            model: string;
            durationMs?: number;
        };
        evaluator?: {
            status: ExecutionStatus;
            reasonCode?: ExecutionReasonCode;
            outcome?: EvaluatorOutcome;
            durationMs?: number;
        };
        generation?: {
            status: ExecutionStatus;
            reasonCode?: ExecutionReasonCode;
            profileId: string;
            originalProfileId?: string;
            effectiveProfileId?: string;
            provider: string;
            model: string;
            durationMs?: number;
        };
        tool?: {
            toolName: ToolExecutionContext['toolName'];
            status: ToolExecutionContext['status'];
            reasonCode?: ToolExecutionContext['reasonCode'];
            durationMs?: ToolExecutionContext['durationMs'];
        };
    };
    workflow?: WorkflowRecord;
    workflowMode?: ResponseMetadata['workflowMode'];
    steerabilityControls?: ResponseMetadata['steerabilityControls'];
};

const normalizePlannerReasonCode = (
    status: ExecutionStatus,
    reasonCode: ExecutionReasonCode | undefined
): PlannerExecutionReasonCode | undefined => {
    if (status === 'executed') {
        return undefined;
    }

    if (
        reasonCode === 'planner_runtime_error' ||
        reasonCode === 'planner_invalid_output'
    ) {
        return reasonCode;
    }

    return 'planner_runtime_error';
};

const parsePlannerPurpose = (
    value: unknown
): PlannerExecutionPurpose | undefined =>
    value === 'chat_orchestrator_action_selection' ? value : undefined;

const parsePlannerContractType = (
    value: unknown
): PlannerExecutionContractType | undefined => {
    if (
        value === 'structured' ||
        value === 'text_json' ||
        value === 'fallback'
    ) {
        return value;
    }

    return undefined;
};

const parsePlannerApplyOutcome = (
    value: unknown
): PlannerExecutionApplyOutcome | undefined => {
    if (
        value === 'applied' ||
        value === 'adjusted_by_policy' ||
        value === 'not_applied'
    ) {
        return value;
    }

    return undefined;
};

const normalizeEvaluatorReasonCode = (
    status: ExecutionStatus,
    reasonCode: ExecutionReasonCode | undefined
): EvaluatorExecutionReasonCode | undefined => {
    if (status === 'executed') {
        return undefined;
    }

    if (reasonCode === 'evaluator_runtime_error') {
        return reasonCode;
    }

    return 'evaluator_runtime_error';
};

const normalizeGenerationReasonCode = (
    status: ExecutionStatus,
    reasonCode: ExecutionReasonCode | undefined
): GenerationExecutionReasonCode | undefined => {
    if (status === 'executed') {
        return undefined;
    }

    if (reasonCode === 'generation_runtime_error') {
        return reasonCode;
    }

    return 'generation_runtime_error';
};

const normalizeToolReasonCode = (
    status: ExecutionStatus,
    reasonCode: ToolInvocationReasonCode | undefined
): ToolInvocationReasonCode | undefined => {
    if (
        reasonCode === 'tool_not_requested' ||
        reasonCode === 'tool_not_used' ||
        reasonCode === 'search_rerouted_to_fallback_profile' ||
        reasonCode === 'search_reroute_not_permitted_by_selection_source' ||
        reasonCode === 'search_reroute_no_tool_capable_fallback_available' ||
        reasonCode === 'tool_unavailable' ||
        reasonCode === 'tool_execution_error' ||
        reasonCode === 'tool_timeout' ||
        reasonCode === 'tool_http_error' ||
        reasonCode === 'tool_network_error' ||
        reasonCode === 'tool_invalid_response' ||
        reasonCode === 'search_not_supported_by_selected_profile' ||
        reasonCode === 'unspecified_tool_outcome'
    ) {
        return reasonCode;
    }

    if (status === 'executed') {
        return undefined;
    }

    return status === 'failed'
        ? 'tool_execution_error'
        : 'unspecified_tool_outcome';
};

/**
 * Builds canonical ResponseMetadata for trace storage and UI rendering.
 * All values are derived from control-plane context and API annotations.
 */
const buildResponseMetadata = (
    assistantMetadata: AssistantResponseMetadata,
    runtimeContext: ResponseMetadataRuntimeContext
): ResponseMetadata => {
    const responseId = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const chainHash = crypto
        .createHash('sha256')
        .update(runtimeContext.conversationSnapshot)
        .digest('hex')
        .substring(0, 16);
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    const citations = Array.isArray(assistantMetadata.citations)
        ? assistantMetadata.citations
        : [];
    const retrieval = runtimeContext.retrieval;
    const classificationToolExecution = runtimeContext.executionContext?.tool;
    const retrievalToolExecuted =
        classificationToolExecution?.status === 'executed' &&
        classificationToolExecution.toolName === 'web_search';
    const provenanceClassification = classifyProvenanceWithSignals({
        assistantProvenance: assistantMetadata.provenance,
        citationCount: citations.length,
        retrievalRequested: retrieval?.requested ?? false,
        retrievalUsed: retrieval?.used ?? false,
        retrievalToolExecuted,
        workflowEvidence: runtimeContext.workflow !== undefined,
        trustGraphEvidenceAvailable:
            runtimeContext.trustGraphEvidenceAvailable ?? false,
        trustGraphEvidenceUsed: runtimeContext.trustGraphEvidenceUsed ?? false,
    });
    const provenance = provenanceClassification.provenance;
    const provenanceAssessment = provenanceClassification.assessment;
    const tradeoffCount = resolveTradeoffCount(
        assistantMetadata.tradeoffCount,
        runtimeContext.plannerTemperament
    );
    const temperament = normalizePlannerTemperament(
        runtimeContext.plannerTemperament
    );
    // TODO(trace-target-vs-final): If review-time runtime can revise TRACE
    // posture, persist both target and final TRACE values. Preserve the
    // invariant that workflow mode is routing metadata while TRACE remains
    // answer-posture metadata.
    const evidenceScore = isTraceAxisScore(assistantMetadata.evidenceScore)
        ? assistantMetadata.evidenceScore
        : undefined;
    const freshnessScore = isTraceAxisScore(assistantMetadata.freshnessScore)
        ? assistantMetadata.freshnessScore
        : undefined;
    const shouldDeriveRetrievedChips =
        provenance === 'Retrieved' &&
        (evidenceScore === undefined || freshnessScore === undefined);
    const derivedRetrievedChips = shouldDeriveRetrievedChips
        ? deriveRetrievedChips({
              citationCount: citations.length,
              intent: retrieval?.intent,
              contextSize: retrieval?.contextSize,
          })
        : undefined;
    const finalEvidenceScore =
        evidenceScore ?? derivedRetrievedChips?.evidenceScore;
    const finalFreshnessScore =
        freshnessScore ?? derivedRetrievedChips?.freshnessScore;

    if (
        provenance === 'Retrieved' &&
        (finalEvidenceScore === undefined || finalFreshnessScore === undefined)
    ) {
        logger.error(
            'Retrieved response metadata is missing required evidence/freshness chips.',
            {
                responseId,
                retrievalRequested: retrieval?.requested ?? false,
                retrievalUsed: retrieval?.used ?? false,
            }
        );
    }

    const safetyTier: SafetyTier = 'Low';
    const licenseContext = 'MIT + HL3';
    const execution: ExecutionEvent[] = [];
    const plannerExecution = runtimeContext.executionContext?.planner;
    if (plannerExecution) {
        // TODO(workflow-planner-step-metadata): If workflows support multiple
        // planner invocations per response, add explicit attempt/correlation
        // metadata without allowing planner events to redefine orchestration
        // authority or step ownership boundaries.
        const normalizedPlannerReasonCode = normalizePlannerReasonCode(
            plannerExecution.status,
            plannerExecution.reasonCode
        );
        const validatedPlannerPurpose = parsePlannerPurpose(
            plannerExecution.purpose
        );
        const validatedPlannerContractType = parsePlannerContractType(
            plannerExecution.contractType
        );
        const validatedPlannerApplyOutcome = parsePlannerApplyOutcome(
            plannerExecution.applyOutcome
        );
        const plannerExecutionSource =
            'runtimeContext.executionContext.planner';
        const invalidPlannerFields: Array<{
            field:
                | 'purpose'
                | 'contractType'
                | 'applyOutcome'
                | 'mattered'
                | 'matteredControlIds';
            value: unknown;
        }> = [];
        if (validatedPlannerPurpose === undefined) {
            invalidPlannerFields.push({
                field: 'purpose',
                value: plannerExecution.purpose,
            });
        }
        if (validatedPlannerContractType === undefined) {
            invalidPlannerFields.push({
                field: 'contractType',
                value: plannerExecution.contractType,
            });
        }
        if (validatedPlannerApplyOutcome === undefined) {
            invalidPlannerFields.push({
                field: 'applyOutcome',
                value: plannerExecution.applyOutcome,
            });
        }
        if (typeof plannerExecution.mattered !== 'boolean') {
            invalidPlannerFields.push({
                field: 'mattered',
                value: plannerExecution.mattered,
            });
        }
        if (!Array.isArray(plannerExecution.matteredControlIds)) {
            invalidPlannerFields.push({
                field: 'matteredControlIds',
                value: plannerExecution.matteredControlIds,
            });
        }

        if (invalidPlannerFields.length > 0) {
            logger.error(
                'planner execution metadata dropped due invalid required fields',
                {
                    responseId,
                    source: plannerExecutionSource,
                    plannerStatus: plannerExecution.status,
                    invalidPlannerFields,
                }
            );
        } else {
            execution.push({
                kind: 'planner',
                status: plannerExecution.status,
                purpose: validatedPlannerPurpose!,
                contractType: validatedPlannerContractType!,
                applyOutcome: validatedPlannerApplyOutcome!,
                mattered: plannerExecution.mattered,
                matteredControlIds: plannerExecution.matteredControlIds,
                profileId: plannerExecution.profileId,
                ...(plannerExecution.originalProfileId !== undefined && {
                    originalProfileId: plannerExecution.originalProfileId,
                }),
                ...(plannerExecution.effectiveProfileId !== undefined && {
                    effectiveProfileId: plannerExecution.effectiveProfileId,
                }),
                provider: plannerExecution.provider,
                model: plannerExecution.model,
                ...(normalizedPlannerReasonCode !== undefined && {
                    reasonCode: normalizedPlannerReasonCode,
                }),
                ...(plannerExecution.durationMs !== undefined && {
                    durationMs: plannerExecution.durationMs,
                }),
            });
        }
    }
    const evaluatorExecution = runtimeContext.executionContext?.evaluator;
    if (evaluatorExecution) {
        const normalizedEvaluatorReasonCode = normalizeEvaluatorReasonCode(
            evaluatorExecution.status,
            evaluatorExecution.reasonCode
        );
        execution.push({
            kind: 'evaluator',
            status: evaluatorExecution.status,
            ...(evaluatorExecution.outcome !== undefined && {
                evaluator: evaluatorExecution.outcome,
            }),
            ...(normalizedEvaluatorReasonCode !== undefined && {
                reasonCode: normalizedEvaluatorReasonCode,
            }),
            ...(evaluatorExecution.durationMs !== undefined && {
                durationMs: evaluatorExecution.durationMs,
            }),
        });
    }
    const toolExecution = runtimeContext.executionContext?.tool;
    if (toolExecution) {
        const normalizedToolReasonCode = normalizeToolReasonCode(
            toolExecution.status,
            toolExecution.reasonCode
        );
        execution.push({
            kind: 'tool',
            status: toolExecution.status,
            toolName: toolExecution.toolName,
            ...(normalizedToolReasonCode !== undefined && {
                reasonCode: normalizedToolReasonCode,
            }),
            ...(toolExecution.durationMs !== undefined && {
                durationMs: toolExecution.durationMs,
            }),
        });
    }
    const generationExecution = runtimeContext.executionContext?.generation;
    if (generationExecution) {
        const normalizedGenerationReasonCode = normalizeGenerationReasonCode(
            generationExecution.status,
            generationExecution.reasonCode
        );
        execution.push({
            kind: 'generation',
            status: generationExecution.status,
            profileId: generationExecution.profileId,
            ...(generationExecution.originalProfileId !== undefined && {
                originalProfileId: generationExecution.originalProfileId,
            }),
            ...(generationExecution.effectiveProfileId !== undefined && {
                effectiveProfileId: generationExecution.effectiveProfileId,
            }),
            provider: generationExecution.provider,
            model: generationExecution.model,
            ...(normalizedGenerationReasonCode !== undefined && {
                reasonCode: normalizedGenerationReasonCode,
            }),
            ...(generationExecution.durationMs !== undefined && {
                durationMs: generationExecution.durationMs,
            }),
        });
    }
    // TODO(workflow-execution-metadata): Extend execution events with lineage
    // (id/parentId), timing (startedAt/finishedAt), and per-step usage/cost
    // once multi-step workflow execution is enabled.
    const generationEventModel = execution
        .filter((event) => event.kind === 'generation')
        .at(-1)?.model;

    return {
        responseId,
        provenance,
        safetyTier,
        tradeoffCount,
        chainHash,
        licenseContext,
        // TODO(workflow-execution-metadata): Remove modelVersion once all
        // metadata consumers have migrated to execution[] as canonical.
        // Compatibility mirror for legacy consumers that still read only a
        // single model string.
        modelVersion:
            generationEventModel ??
            runtimeContext.modelVersion ??
            runtimeConfig.openai.defaultModel,
        staleAfter: new Date(Date.now() + ninetyDaysMs).toISOString(),
        citations,
        provenanceAssessment,
        ...(runtimeContext.totalDurationMs !== undefined && {
            totalDurationMs: runtimeContext.totalDurationMs,
        }),
        ...(execution.length > 0 && { execution }),
        ...(runtimeContext.workflow !== undefined && {
            workflow: runtimeContext.workflow,
        }),
        ...(runtimeContext.workflowMode !== undefined && {
            workflowMode: runtimeContext.workflowMode,
        }),
        ...(runtimeContext.steerabilityControls !== undefined && {
            steerabilityControls: runtimeContext.steerabilityControls,
        }),
        ...(evaluatorExecution?.outcome !== undefined && {
            evaluator: evaluatorExecution.outcome,
        }),
        ...(temperament && { temperament }),
        ...(finalEvidenceScore !== undefined && {
            evidenceScore: finalEvidenceScore,
        }),
        ...(finalFreshnessScore !== undefined && {
            freshnessScore: finalFreshnessScore,
        }),
    };
};

export type {
    AssistantResponseMetadata,
    AssistantUsage,
    GenerateResponseOptions,
    OpenAIService,
    OpenAIResponseMetadata,
    ResponseMetadataRetrievalContext,
    ResponseMetadataRuntimeContext,
};
export {
    SimpleOpenAIService,
    buildResponseMetadata,
    extractMarkdownLinkCitations,
    normalizeFallbackCitationTitle,
};
