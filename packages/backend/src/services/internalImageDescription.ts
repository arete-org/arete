/**
 * @description: Calls the provider for backend-owned image-description tasks.
 * @footnote-scope: core
 * @footnote-module: InternalImageDescriptionAdapter
 * @footnote-risk: high - Bad request mapping or response parsing here can break reflect grounding or leak provider-specific failures.
 * @footnote-ethics: medium - Image descriptions shape what the assistant says about uploaded content, so prompt handling and OCR extraction must stay predictable.
 */
import { logger as defaultLogger } from '../utils/logger.js';

const IMAGE_DESCRIPTION_TOOL_NAME = 'describe_image';
const IMAGE_DESCRIPTION_MODEL = 'gpt-4o-mini';
const IMAGE_DESCRIPTION_DETAIL = 'auto';
const IMAGE_DESCRIPTION_MAX_TOKENS = 16384;
const IMAGE_DESCRIPTION_DEFAULT_CONTENT_TYPE = 'image/jpeg';

type ImageDescriptionStructuredPayload = {
    key_elements: string[];
    table_markdown?: string[];
    [key: string]: unknown;
};

type ImageDescriptionPayload = {
    summary: string;
    detected_type: string;
    extracted_text: string[];
    structured: ImageDescriptionStructuredPayload;
    certainty: string;
    notes?: string;
};

type ImageDescriptionToolCall = {
    type?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
};

type ImageDescriptionCompletionResponse = {
    choices?: Array<{
        message?: {
            tool_calls?: ImageDescriptionToolCall[];
        };
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
};

export type InternalImageDescriptionAdapterRequest = {
    imageUrl: string;
    prompt: string;
};

export type InternalImageDescriptionAdapterResult = {
    description: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

export type InternalImageDescriptionAdapter = {
    describeImage(
        request: InternalImageDescriptionAdapterRequest
    ): Promise<InternalImageDescriptionAdapterResult>;
};

export type CreateOpenAiImageDescriptionAdapterOptions = {
    apiKey: string;
    requestTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    logger?: Pick<typeof defaultLogger, 'warn'>;
};

const IMAGE_DESCRIPTION_TOOL_SCHEMA = {
    type: 'function',
    function: {
        name: IMAGE_DESCRIPTION_TOOL_NAME,
        description:
            'You are an image parsing tool. Extract the minimum reliable information a downstream assistant needs to respond. Prioritize verbatim text and obvious structure. You may add light interpretive context when it is strongly implied by the image (e.g., mood, scene type), but do not guess identities or solve tasks. Keep output short.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: [
                'summary',
                'detected_type',
                'extracted_text',
                'structured',
                'certainty',
            ],
            properties: {
                summary: {
                    type: 'string',
                    description: '1-2 sentence neutral caption.',
                },
                detected_type: {
                    type: 'string',
                    description:
                        'Short label (1-3 words). Choose the dominant type and avoid compound labels.',
                },
                extracted_text: {
                    type: 'array',
                    items: {
                        type: 'string',
                    },
                    description:
                        'Up to ~20 lines of verbatim text in reading order. Omit repeated low-value text.',
                },
                structured: {
                    type: 'object',
                    required: ['key_elements'],
                    additionalProperties: true,
                    properties: {
                        key_elements: {
                            type: 'array',
                            items: {
                                type: 'string',
                            },
                            description:
                                'Short bullets capturing the most salient elements.',
                        },
                        table_markdown: {
                            type: 'array',
                            items: {
                                type: 'string',
                            },
                            description:
                                'Optional markdown tables when tables are clearly visible.',
                        },
                    },
                },
                certainty: {
                    type: 'string',
                    description: 'Short confidence qualifier.',
                },
                notes: {
                    type: 'string',
                    description:
                        'Optional; one short sentence on unreadable or ambiguous parts.',
                },
            },
        },
    },
} as const;

const normalizeImageDescriptionPayload = (
    payload: unknown
): ImageDescriptionPayload | null => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    const payloadRecord = payload as Record<string, unknown>;
    const normalizeNonEmptyString = (value: unknown): string | undefined => {
        if (typeof value !== 'string') {
            return undefined;
        }

        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    };

    const summary =
        normalizeNonEmptyString(payloadRecord.summary) ??
        'Unable to reliably describe image.';
    const detectedType =
        normalizeNonEmptyString(payloadRecord.detected_type) ?? 'other';
    const extractedText = Array.isArray(payloadRecord.extracted_text)
        ? payloadRecord.extracted_text.filter(
              (item): item is string => typeof item === 'string'
          )
        : [];
    const certainty =
        normalizeNonEmptyString(payloadRecord.certainty) ??
        normalizeNonEmptyString(payloadRecord.confidence) ??
        'low';

    const structuredValue = payloadRecord.structured ?? {};
    const structuredRecord =
        structuredValue &&
        typeof structuredValue === 'object' &&
        !Array.isArray(structuredValue)
            ? (structuredValue as Record<string, unknown>)
            : {};
    const keyElements = Array.isArray(structuredRecord.key_elements)
        ? structuredRecord.key_elements.filter(
              (item): item is string => typeof item === 'string'
          )
        : [];
    const tableMarkdown = Array.isArray(structuredRecord.table_markdown)
        ? structuredRecord.table_markdown.filter(
              (item): item is string => typeof item === 'string'
          )
        : undefined;
    const notes = normalizeNonEmptyString(payloadRecord.notes);

    return {
        summary,
        detected_type: detectedType,
        extracted_text: extractedText,
        structured: {
            ...structuredRecord,
            key_elements: keyElements,
            ...(tableMarkdown ? { table_markdown: tableMarkdown } : {}),
        },
        certainty,
        ...(notes ? { notes } : {}),
    };
};

const parseImageDescriptionToolPayload = (
    toolCalls: ImageDescriptionToolCall[] | undefined,
    logger: Pick<typeof defaultLogger, 'warn'>
): ImageDescriptionPayload | null => {
    const toolCall = toolCalls?.find(
        (call) =>
            call.type === 'function' &&
            call.function?.name === IMAGE_DESCRIPTION_TOOL_NAME
    );

    if (!toolCall?.function?.arguments) {
        return null;
    }

    try {
        return normalizeImageDescriptionPayload(
            JSON.parse(toolCall.function.arguments) as unknown
        );
    } catch (error) {
        logger.warn(
            `Internal image-description adapter returned invalid tool JSON: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
};

const detectContentTypeFromUrl = (imageUrl: string): string | null => {
    try {
        const pathname = new URL(imageUrl).pathname.toLowerCase();
        if (pathname.endsWith('.png')) {
            return 'image/png';
        }
        if (pathname.endsWith('.webp')) {
            return 'image/webp';
        }
        if (pathname.endsWith('.gif')) {
            return 'image/gif';
        }
        if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
            return 'image/jpeg';
        }
    } catch {
        return null;
    }

    return null;
};

const fetchImageAsDataUrl = async (
    imageUrl: string,
    fetchImpl: typeof fetch,
    signal?: AbortSignal
): Promise<string> => {
    const response = await fetchImpl(imageUrl, { signal });
    if (!response.ok) {
        throw new Error(
            `Failed to download image for description: ${response.status} ${response.statusText}`
        );
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString('base64');
    const contentType =
        response.headers.get('content-type') ??
        detectContentTypeFromUrl(imageUrl) ??
        IMAGE_DESCRIPTION_DEFAULT_CONTENT_TYPE;

    return `data:${contentType};base64,${base64Image}`;
};

const createTimeoutSignal = (
    timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timeoutHandle),
    };
};

export const createOpenAiImageDescriptionAdapter = ({
    apiKey,
    requestTimeoutMs = 30_000,
    fetchImpl = fetch,
    logger = defaultLogger,
}: CreateOpenAiImageDescriptionAdapterOptions): InternalImageDescriptionAdapter => ({
    async describeImage(
        request: InternalImageDescriptionAdapterRequest
    ): Promise<InternalImageDescriptionAdapterResult> {
        const abortContext = createTimeoutSignal(requestTimeoutMs);

        try {
            const imageDataUrl = await fetchImageAsDataUrl(
                request.imageUrl,
                fetchImpl,
                abortContext.signal
            );
            const response = await fetchImpl(
                'https://api.openai.com/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: IMAGE_DESCRIPTION_MODEL,
                        max_completion_tokens: IMAGE_DESCRIPTION_MAX_TOKENS,
                        tools: [IMAGE_DESCRIPTION_TOOL_SCHEMA],
                        tool_choice: {
                            type: 'function',
                            function: {
                                name: IMAGE_DESCRIPTION_TOOL_NAME,
                            },
                        },
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    {
                                        type: 'text',
                                        text: request.prompt,
                                    },
                                    {
                                        type: 'image_url',
                                        image_url: {
                                            url: imageDataUrl,
                                            detail: IMAGE_DESCRIPTION_DETAIL,
                                        },
                                    },
                                ],
                            },
                        ],
                    }),
                    signal: abortContext.signal,
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(
                    `Image-description request failed: ${response.status} ${response.statusText} - ${errorText}`
                );
            }

            const completion =
                (await response.json()) as ImageDescriptionCompletionResponse;
            const payload = parseImageDescriptionToolPayload(
                completion.choices?.[0]?.message?.tool_calls,
                logger
            );
            if (!payload) {
                throw new Error(
                    'Internal image-description task did not return a valid tool payload.'
                );
            }

            const promptTokens = completion.usage?.prompt_tokens ?? 0;
            const completionTokens = completion.usage?.completion_tokens ?? 0;
            const totalTokens =
                completion.usage?.total_tokens ??
                promptTokens + completionTokens;

            return {
                description: JSON.stringify(payload),
                model: IMAGE_DESCRIPTION_MODEL,
                promptTokens,
                completionTokens,
                totalTokens,
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(
                    `Image-description request timed out after ${requestTimeoutMs}ms`
                );
            }
            throw error;
        } finally {
            abortContext.cleanup();
        }
    },
});

export { detectContentTypeFromUrl };
