/**
 * @description: Minimal OpenAI client wrapper and response metadata builder for reflect API.
 * @footnote-scope: utility
 * @footnote-module: ReflectOpenAIService
 * @footnote-risk: high - Incorrect handling can degrade responses, retrieval quality, or metadata integrity.
 * @footnote-ethics: high - Misreported provenance or dropped retrieval harms trust and transparency.
 */
import crypto from 'node:crypto';
import type {
    Citation,
    PartialResponseTemperament,
    Provenance,
    ResponseMetadata,
    RiskTier,
    TraceAxisScore,
} from '@footnote/contracts/ethics-core';
import { extractTextAndMetadata } from '../utils/metadata.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { buildWebSearchInstruction } from './reflectGenerationHints.js';
import type {
    ReflectRepoSearchHint,
    ReflectSearchIntent,
} from './reflectGenerationTypes.js';

type OpenAIUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
};

type ParsedMetadata = {
    provenance?: string;
    tradeoffCount?: number;
    citations?: unknown[];
    evidenceScore?: unknown;
    freshnessScore?: unknown;
};

type OpenAIResponseMetadata = {
    model: string;
    usage?: OpenAIUsage;
    finishReason?: string;
    reasoningEffort?: string;
    verbosity?: string;
} & ParsedMetadata;

type GenerateResponseResult = {
    normalizedText: string;
    metadata: OpenAIResponseMetadata;
};

type GenerateResponseOptions = {
    expectMetadata?: boolean;
    maxCompletionTokens?: number;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    verbosity?: 'low' | 'medium' | 'high';
    toolChoice?: 'none' | 'web_search';
    webSearch?: {
        query: string;
        searchContextSize: 'low' | 'medium' | 'high';
        searchIntent: ReflectSearchIntent;
        repoHints?: ReflectRepoSearchHint[];
    };
};

interface OpenAIService {
    generateResponse(
        model: string,
        messages: Array<{ role: string; content: string }>,
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

const isTraceAxisScore = (value: unknown): value is TraceAxisScore =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5;

const normalizeTraceAxisScore = (
    value: unknown
): TraceAxisScore | undefined => {
    if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 5
    ) {
        return value as TraceAxisScore;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!/^\d+$/.test(trimmed)) {
            return undefined;
        }
        const parsed = Number.parseInt(trimmed, 10);
        return isTraceAxisScore(parsed) ? parsed : undefined;
    }

    return undefined;
};

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

const normalizeVerbosity = (
    value: GenerateResponseOptions['verbosity']
): NonNullable<GenerateResponseOptions['verbosity']> => {
    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

const buildInputMessage = (
    role: string,
    text: string
): ResponsesApiInputMessage => ({
    role,
    type: 'message',
    content: role === 'assistant' ? text : [{ type: 'input_text', text }],
});

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
        messages: Array<{ role: string; content: string }>,
        options: GenerateResponseOptions = {}
    ): Promise<GenerateResponseResult> {
        const validMessages = messages.filter((message) => {
            if (!message.content || !message.content.trim()) {
                logger.warn(
                    `Filtering out invalid backend reflect message with role=${message.role}`
                );
                return false;
            }

            return true;
        });

        const normalizedReasoningEffort = normalizeReasoningEffort(
            options.reasoningEffort
        );
        const normalizedVerbosity = normalizeVerbosity(options.verbosity);
        const shouldUseWebSearch = options.toolChoice === 'web_search';
        const hasValidWebSearch =
            shouldUseWebSearch &&
            typeof options.webSearch?.query === 'string' &&
            options.webSearch.query.trim().length > 0;

        if (shouldUseWebSearch && !hasValidWebSearch) {
            logger.warn(
                'Backend reflect requested web_search without a usable query; falling back to toolChoice=none.'
            );
        }

        const tools: ResponsesApiTool[] = [];
        if (hasValidWebSearch && options.webSearch) {
            tools.push({
                type: 'web_search',
                search_context_size: options.webSearch.searchContextSize,
            });
        }

        const requestInput: ResponsesApiInputMessage[] = [
            ...validMessages.map((message) =>
                buildInputMessage(message.role, message.content)
            ),
            ...(hasValidWebSearch && options.webSearch
                ? [
                      buildInputMessage(
                          'system',
                          buildWebSearchInstruction({
                              ...options.webSearch,
                              repoHints: options.webSearch.repoHints ?? [],
                          })
                      ),
                  ]
                : []),
        ];

        const requestBody = JSON.stringify({
            model,
            input: requestInput,
            max_output_tokens: options.maxCompletionTokens ?? 4000,
            reasoning: { effort: normalizedReasoningEffort },
            text: { verbosity: normalizedVerbosity },
            ...(tools.length > 0 && { tools }),
        });

        const performRequest = async (attempt: number): Promise<Response> => {
            let abortSignal: AbortSignal;
            try {
                abortSignal = AbortSignal.timeout(this.requestTimeoutMs);
            } catch {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), this.requestTimeoutMs);
                abortSignal = controller.signal;
            }

            try {
                return await fetch('https://api.openai.com/v1/responses', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: requestBody,
                    signal: abortSignal,
                });
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new Error(
                        `OpenAI request timed out after ${this.requestTimeoutMs}ms`
                    );
                }

                if (attempt < this.retryAttempts) {
                    const backoffMs = 300 * (attempt + 1);
                    await new Promise((resolve) =>
                        setTimeout(resolve, backoffMs)
                    );
                    return performRequest(attempt + 1);
                }

                throw error;
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

        const expectMetadata = options.expectMetadata !== false;
        const extracted = expectMetadata
            ? extractTextAndMetadata(rawOutputText)
            : {
                  normalizedText: rawOutputText.trimEnd(),
                  metadata: null,
              };
        const parsedMetadata = extracted.metadata as ParsedMetadata | null;

        const normalizedEvidenceScore = normalizeTraceAxisScore(
            parsedMetadata?.evidenceScore
        );
        const normalizedFreshnessScore = normalizeTraceAxisScore(
            parsedMetadata?.freshnessScore
        );

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
            ...(parsedMetadata && {
                provenance: parsedMetadata.provenance,
                tradeoffCount: parsedMetadata.tradeoffCount,
                citations: parsedMetadata.citations,
                ...(normalizedEvidenceScore !== undefined && {
                    evidenceScore: normalizedEvidenceScore,
                }),
                ...(normalizedFreshnessScore !== undefined && {
                    freshnessScore: normalizedFreshnessScore,
                }),
            }),
        };

        return {
            normalizedText: extracted.normalizedText,
            metadata: assistantMetadata,
        };
    }
}

type ResponseMetadataRuntimeContext = {
    modelVersion: string;
    conversationSnapshot: string;
    plannerTemperament?: PartialResponseTemperament;
    usedWebSearch?: boolean;
};

const buildResponseMetadata = (
    assistantMetadata: OpenAIResponseMetadata,
    runtimeContext: ResponseMetadataRuntimeContext
): ResponseMetadata => {
    const responseId = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const chainHash = crypto
        .createHash('sha256')
        .update(runtimeContext.conversationSnapshot)
        .digest('hex')
        .substring(0, 16);
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    const provenance =
        (assistantMetadata.provenance as Provenance) || 'Inferred';
    const tradeoffCount =
        typeof assistantMetadata.tradeoffCount === 'number'
            ? assistantMetadata.tradeoffCount
            : 0;
    const citations = Array.isArray(assistantMetadata.citations)
        ? (assistantMetadata.citations as Citation[])
        : [];
    const temperament = normalizePlannerTemperament(
        runtimeContext.plannerTemperament
    );
    const evidenceScore = isTraceAxisScore(assistantMetadata.evidenceScore)
        ? assistantMetadata.evidenceScore
        : undefined;
    const freshnessScore = isTraceAxisScore(assistantMetadata.freshnessScore)
        ? assistantMetadata.freshnessScore
        : undefined;
    const shouldBackfillTraceChips =
        runtimeContext.usedWebSearch === true &&
        provenance === 'Retrieved' &&
        (evidenceScore === undefined || freshnessScore === undefined);
    const normalizedEvidenceScore =
        evidenceScore ?? (shouldBackfillTraceChips ? 3 : undefined);
    const normalizedFreshnessScore =
        freshnessScore ?? (shouldBackfillTraceChips ? 3 : undefined);

    const riskTier: RiskTier = 'Low';
    const licenseContext = 'MIT + HL3';

    return {
        responseId,
        provenance,
        riskTier,
        tradeoffCount,
        chainHash,
        licenseContext,
        modelVersion:
            runtimeContext.modelVersion || runtimeConfig.openai.defaultModel,
        staleAfter: new Date(Date.now() + ninetyDaysMs).toISOString(),
        citations,
        ...(temperament && { temperament }),
        ...(normalizedEvidenceScore !== undefined && {
            evidenceScore: normalizedEvidenceScore,
        }),
        ...(normalizedFreshnessScore !== undefined && {
            freshnessScore: normalizedFreshnessScore,
        }),
    };
};

export type {
    GenerateResponseOptions,
    OpenAIService,
    OpenAIResponseMetadata,
    ResponseMetadataRuntimeContext,
};
export { SimpleOpenAIService, buildResponseMetadata };
