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

        return JSON.parse(
            candidate.slice(firstBraceIndex, lastBraceIndex + 1)
        ) as unknown;
    }
};

const buildNewsJsonInstruction = (maxResults: number): string =>
    [
        'Return only one JSON object and no surrounding prose or markdown.',
        'The JSON object must have exactly two top-level keys: "news" and "summary".',
        `"news" must be an array with at most ${maxResults} items.`,
        'Each news item must include: title, summary, url, source, and timestamp.',
        'thumbnail and image are optional and may be null.',
        'Use ISO-8601 timestamps when known. If a timestamp cannot be confirmed, omit the article instead of inventing one.',
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
            result: extractJsonPayload(generationResult.text),
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
