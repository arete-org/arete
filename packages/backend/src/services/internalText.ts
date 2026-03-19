/**
 * @description: Runs the trusted internal `/news` task through the shared backend runtime.
 * @footnote-scope: core
 * @footnote-module: InternalNewsTaskService
 * @footnote-risk: high - Invalid task parsing here can break `/news` or return malformed structured results to trusted callers.
 * @footnote-ethics: medium - Backend-owned news prompts and parsing affect what current events users see and how clearly they are summarized.
 */
import type { GenerationRuntime } from '@footnote/agent-runtime';
import type {
    PostInternalNewsTaskRequest,
    PostInternalNewsTaskResponse,
} from '@footnote/contracts/web';
import { PostInternalNewsTaskResponseSchema } from '@footnote/contracts/web/schemas';
import { renderPrompt } from './prompts/promptRegistry.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import { logger } from '../utils/logger.js';

const DEFAULT_NEWS_MAX_RESULTS = 3;
const MAX_NEWS_RESULTS = 5;
const DEFAULT_NEWS_QUERY = 'latest news';

export type CreateInternalNewsTaskServiceOptions = {
    generationRuntime: GenerationRuntime;
    defaultModel: string;
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

export type InternalNewsTaskService = {
    runNewsTask(
        request: PostInternalNewsTaskRequest
    ): Promise<PostInternalNewsTaskResponse>;
};

const normalizeOptionalString = (value: string | undefined): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const clampNewsMaxResults = (maxResults: number | undefined): number => {
    if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) {
        return DEFAULT_NEWS_MAX_RESULTS;
    }

    return Math.min(MAX_NEWS_RESULTS, Math.max(1, Math.round(maxResults)));
};

const buildNewsSearchQuery = ({
    query,
    category,
}: {
    query?: string;
    category?: string;
}): string => query ?? category ?? DEFAULT_NEWS_QUERY;

const hasExplicitTimeComponent = (value: string): boolean =>
    /(?:T|\s)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}|[AP]M))?/i.test(
        value
    );

const isMidnightTimestamp = (date: Date): boolean =>
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;

const normalizeNewsTimestamp = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    const parsedDate = new Date(trimmed);
    if (Number.isNaN(parsedDate.getTime())) {
        return undefined;
    }

    // Many publishers expose only a publish date. Treat midnight placeholders
    // as "time unknown" so the UI does not imply precision we never gathered.
    if (isMidnightTimestamp(parsedDate) && !hasExplicitTimeComponent(trimmed)) {
        return undefined;
    }

    if (
        isMidnightTimestamp(parsedDate) &&
        /(?:T|\s)00:00(?::00(?:\.0+)?)?/i.test(trimmed)
    ) {
        return undefined;
    }

    return parsedDate.toISOString();
};

/**
 * The news task can keep an article even when publish time is fuzzy. We
 * normalize trustworthy timestamps, but strip placeholder or malformed ones
 * so one weak date does not sink the whole response.
 */
const normalizeNewsTaskResult = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const candidate = value as {
        news?: unknown;
        summary?: unknown;
    };
    if (!Array.isArray(candidate.news)) {
        return value;
    }

    const normalizedNews = candidate.news.flatMap((item) => {
        if (!item || typeof item !== 'object') {
            return [];
        }

        const itemRecord = item as Record<string, unknown>;
        const normalizedTimestamp = normalizeNewsTimestamp(itemRecord.timestamp);
        const { timestamp: _timestamp, ...rest } = itemRecord;

        return [
            {
                ...rest,
                ...(normalizedTimestamp
                    ? { timestamp: normalizedTimestamp }
                    : {}),
            },
        ];
    });

    return {
        ...candidate,
        news: normalizedNews,
    };
};

/**
 * The news task asks the model for raw JSON, but models still sometimes wrap
 * that JSON in markdown fences or brief prose. We recover the common wrappers
 * here so the endpoint can stay fail-open for formatting mistakes without
 * accepting arbitrary non-JSON output.
 */
const extractJsonPayload = (rawText: string): unknown => {
    const trimmed = rawText.trim();
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

    try {
        return JSON.parse(candidate) as unknown;
    } catch {
        const firstBraceIndex = candidate.indexOf('{');
        const lastBraceIndex = candidate.lastIndexOf('}');
        if (firstBraceIndex === -1 || lastBraceIndex <= firstBraceIndex) {
            throw new Error('Internal text task did not return a JSON object.');
        }

        try {
            return JSON.parse(
                candidate.slice(firstBraceIndex, lastBraceIndex + 1)
            ) as unknown;
        } catch (error) {
            const parseMessage =
                error instanceof Error ? ` ${error.message}` : '';
            throw new Error(
                `Internal text task did not return a JSON object.${parseMessage}`
            );
        }
    }
};

const buildNewsJsonInstruction = (maxResults: number): string =>
    [
        'Return only one JSON object and no surrounding prose or markdown.',
        'The JSON object must have exactly two top-level keys: "news" and "summary".',
        `"news" must be an array with at most ${maxResults} items.`,
        'Each news item must include: title, summary, url, and source.',
        'timestamp is optional and should only be included when a publish time is actually confirmed.',
        'thumbnail and image are optional and may be null.',
        'Use ISO-8601 timestamps when known. If only a publish date is known, omit timestamp instead of inventing a midnight time.',
    ].join(' ');

export const createInternalNewsTaskService = ({
    generationRuntime,
    defaultModel,
    recordUsage = recordBackendLLMUsage,
}: CreateInternalNewsTaskServiceOptions): InternalNewsTaskService => {
    const runNewsTask = async (
        request: PostInternalNewsTaskRequest
    ): Promise<PostInternalNewsTaskResponse> => {
        const query = normalizeOptionalString(request.query);
        const category = normalizeOptionalString(request.category);
        const maxResults = clampNewsMaxResults(request.maxResults);
        const searchQuery = buildNewsSearchQuery({ query, category });
        const { content: systemPrompt } = renderPrompt('text.news.system', {
            query: query ?? 'Not specified',
            category: category ?? 'Not specified',
            maxResults,
        });

        const generationResult = await generationRuntime.generate({
            model: defaultModel,
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'system',
                    content: buildNewsJsonInstruction(maxResults),
                },
                {
                    role: 'user',
                    content: `News task inputs: ${JSON.stringify({
                        query,
                        category,
                        maxResults,
                        channelContext: request.channelContext,
                    })}`,
                },
            ],
            reasoningEffort: request.reasoningEffort ?? 'medium',
            verbosity: request.verbosity ?? 'medium',
            search: {
                query: searchQuery,
                contextSize: 'medium',
                intent: 'current_facts',
            },
        });

        const usageModel = generationResult.model ?? defaultModel;
        const promptTokens = generationResult.usage?.promptTokens ?? 0;
        const completionTokens = generationResult.usage?.completionTokens ?? 0;
        const totalTokens =
            generationResult.usage?.totalTokens ?? promptTokens + completionTokens;

        try {
            recordUsage({
                feature: 'news',
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
                `Internal news task usage recording failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        const responsePayload = {
            task: 'news' as const,
            result: normalizeNewsTaskResult(
                extractJsonPayload(generationResult.text)
            ),
        };
        const parsedResponse =
            PostInternalNewsTaskResponseSchema.safeParse(responsePayload);
        if (!parsedResponse.success) {
            const firstIssue = parsedResponse.error.issues[0];
            throw new Error(
                `Internal news task returned invalid structured output: ${firstIssue?.path.join('.') ?? 'body'} ${firstIssue?.message ?? 'Invalid response'}`
            );
        }

        return parsedResponse.data;
    };

    return {
        runNewsTask,
    };
};
