/**
 * @description: Runs the trusted internal text tasks that backend owns directly, including `/news` and image-description grounding.
 * @footnote-scope: core
 * @footnote-module: InternalTextTaskService
 * @footnote-risk: high - Invalid task parsing here can break trusted helper flows or return malformed structured results to callers.
 * @footnote-ethics: medium - Backend-owned prompt assembly and normalization affect what users see and how clearly helper results are explained.
 */
import type { GenerationRuntime } from '@footnote/agent-runtime';
import type {
    PostInternalImageDescriptionTaskRequest,
    PostInternalImageDescriptionTaskResponse,
    PostInternalNewsTaskRequest,
    PostInternalNewsTaskResponse,
} from '@footnote/contracts/web';
import {
    PostInternalImageDescriptionTaskResponseSchema,
    PostInternalNewsTaskResponseSchema,
} from '@footnote/contracts/web/schemas';
import { renderPrompt } from './prompts/promptRegistry.js';
import {
    estimateBackendTextCost,
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import type { InternalImageDescriptionAdapter } from './internalImageDescription.js';
import { logger } from '../utils/logger.js';

/**
 * @footnote-logger: internalTextTaskService
 * @logs: Task start/finish metadata, usage summaries, and schema failures for internal text helpers.
 * @footnote-risk: high - Missing logs hide helper regressions or unexpected cost spikes.
 * @footnote-ethics: medium - Text tasks can contain user content, so logs stay metadata-only.
 */
const textTaskLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'internalTextTaskService' })
        : logger;

const DEFAULT_NEWS_MAX_RESULTS = 3;
const MAX_NEWS_RESULTS = 5;
const DEFAULT_NEWS_QUERY = 'latest news';
const IMAGE_DESCRIPTION_KEY_ELEMENTS_MIN = 3;
const IMAGE_DESCRIPTION_KEY_ELEMENTS_MAX = 7;
const IMAGE_DESCRIPTION_EXTRACTED_TEXT_LIMIT = 20;
const IMAGE_DESCRIPTION_PROMPT_TEMPLATE = `You are an image parsing tool for a Discord assistant.

Goal: produce a structured payload so a downstream assistant can respond appropriately. Add detail when it materially helps (e.g., distinctive clothing, setting, actions, or objects that change the interpretation). You may include light interpretive context (mood, scene type, implied activity) when it is strongly suggested by visible evidence.

Prioritize utility:
- If there is readable text (including UI, logs, code, tables, forms): extract it verbatim and in reading order.
- Prefer content text over UI labels unless labels are needed to interpret the content.
- If there is obvious structure (tables, grids, charts, forms, diagrams, UI layout): capture the structure at a high level without interpretation.
- If it is primarily a photo/scene: name the main subjects, setting, and any prominent text/signage.

If text is partially unreadable, do not guess. Include only what you can read; mention uncertainty in notes.
Prefer meaningful content over repeated UI chrome (menus, timestamps, icons) unless it is necessary context.
If a clear grid layout is present (e.g., Sudoku), avoid dumping per-cell OCR unless exact values are needed; prefer encoding rows/columns in structured and keep extracted_text minimal (labels/instructions only).
If a clear table is present, you may include one or more markdown tables under structured.table_markdown; keep extracted_text minimal and focused on non-tabular labels.

Soft length limits:
- summary: ~1-3 sentences (up to a paragraph when the scene is complex or ambiguous)
- key elements: {{key_elements_target}} short bullets (place these under structured.key_elements)
- extracted_text: up to ~{{extracted_text_limit}} lines, verbatim; omit repeated low-value text
- notes: optional, one short sentence
Always include structured.key_elements as an array of short bullets (empty if none).

Return ONLY via the describe_image tool call, as valid JSON matching the tool schema.

Additional context (may indicate what to focus on): {{context}}

{{context_block}}`;

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

export type CreateInternalImageDescriptionTaskServiceOptions = {
    adapter: InternalImageDescriptionAdapter;
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

export type InternalImageDescriptionTaskService = {
    runImageDescriptionTask(
        request: PostInternalImageDescriptionTaskRequest
    ): Promise<PostInternalImageDescriptionTaskResponse>;
};

const normalizeOptionalString = (
    value: string | undefined
): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const safeHostnameFromUrl = (value: string | undefined): string | null => {
    if (!value) {
        return null;
    }

    try {
        return new URL(value).hostname;
    } catch {
        return null;
    }
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
        const normalizedTimestamp = normalizeNewsTimestamp(
            itemRecord.timestamp
        );
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
                `Internal text task did not return a JSON object.${parseMessage}`,
                { cause: error }
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

const buildImageDescriptionPrompt = (context?: string): string => {
    const trimmedContext = context?.trim();
    const normalizedContext =
        trimmedContext && trimmedContext.length > 0 ? trimmedContext : '(none)';
    const contextBlock =
        trimmedContext && trimmedContext.length > 0
            ? `Additional context: ${trimmedContext}`
            : '';

    return IMAGE_DESCRIPTION_PROMPT_TEMPLATE.replace(
        '{{context}}',
        normalizedContext
    )
        .replace('{{context_block}}', contextBlock)
        .replace(
            '{{key_elements_target}}',
            `${IMAGE_DESCRIPTION_KEY_ELEMENTS_MIN}-${IMAGE_DESCRIPTION_KEY_ELEMENTS_MAX}`
        )
        .replace(
            '{{extracted_text_limit}}',
            String(IMAGE_DESCRIPTION_EXTRACTED_TEXT_LIMIT)
        );
};

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
        textTaskLogger.debug('Internal news task starting.', {
            queryLength: query?.length ?? 0,
            categoryLength: category?.length ?? 0,
            maxResults,
            reasoningEffort: request.reasoningEffort ?? 'medium',
            verbosity: request.verbosity ?? 'medium',
            searchQueryLength: searchQuery.length,
            hasChannelContext: Boolean(request.channelContext),
        });
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
            generationResult.usage?.totalTokens ??
            promptTokens + completionTokens;

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
            textTaskLogger.warn(
                `Internal news task usage recording failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        textTaskLogger.info('Internal news task complete.', {
            model: usageModel,
            promptTokens,
            completionTokens,
            totalTokens,
        });

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

export const createInternalImageDescriptionTaskService = ({
    adapter,
    recordUsage = recordBackendLLMUsage,
}: CreateInternalImageDescriptionTaskServiceOptions): InternalImageDescriptionTaskService => {
    const runImageDescriptionTask = async (
        request: PostInternalImageDescriptionTaskRequest
    ): Promise<PostInternalImageDescriptionTaskResponse> => {
        const imageHost = safeHostnameFromUrl(request.imageUrl);
        textTaskLogger.debug('Internal image-description task starting.', {
            imageHost,
            contextLength: request.context?.length ?? 0,
        });
        const result = await adapter.describeImage({
            imageUrl: request.imageUrl,
            prompt: buildImageDescriptionPrompt(request.context),
        });
        const promptTokens = result.promptTokens;
        const completionTokens = result.completionTokens;
        const totalTokens = result.totalTokens;
        const costs = estimateBackendTextCost(
            result.model,
            promptTokens,
            completionTokens
        );

        try {
            recordUsage({
                feature: 'image_description',
                model: result.model,
                promptTokens,
                completionTokens,
                totalTokens,
                ...costs,
                timestamp: Date.now(),
            });
        } catch (error) {
            textTaskLogger.warn(
                `Internal image-description task usage recording failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        textTaskLogger.info('Internal image-description task complete.', {
            model: result.model,
            promptTokens,
            completionTokens,
            totalTokens,
        });

        const responsePayload = {
            task: 'image_description' as const,
            result: {
                description: result.description,
                model: result.model,
                usage: {
                    inputTokens: promptTokens,
                    outputTokens: completionTokens,
                    totalTokens,
                },
                costs: {
                    input: costs.inputCostUsd,
                    output: costs.outputCostUsd,
                    total: costs.totalCostUsd,
                },
            },
        };
        const parsedResponse =
            PostInternalImageDescriptionTaskResponseSchema.safeParse(
                responsePayload
            );
        if (!parsedResponse.success) {
            const firstIssue = parsedResponse.error.issues[0];
            throw new Error(
                `Internal image-description task returned invalid structured output: ${firstIssue?.path.join('.') ?? 'body'} ${firstIssue?.message ?? 'Invalid response'}`
            );
        }

        return parsedResponse.data;
    };

    return {
        runImageDescriptionTask,
    };
};
