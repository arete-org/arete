/**
 * @description: Calls the provider for backend-owned image-description tasks.
 * @footnote-scope: core
 * @footnote-module: InternalImageDescriptionAdapter
 * @footnote-risk: high - Bad request mapping or response parsing here can break reflect grounding or leak provider-specific failures.
 * @footnote-ethics: medium - Image descriptions shape what the assistant says about uploaded content, so prompt handling and OCR extraction must stay predictable.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

import { logger as defaultLogger } from '../utils/logger.js';

const IMAGE_DESCRIPTION_TOOL_NAME = 'describe_image';
const IMAGE_DESCRIPTION_MODEL = 'gpt-4o-mini';
const IMAGE_DESCRIPTION_DETAIL = 'auto';
const IMAGE_DESCRIPTION_MAX_TOKENS = 16384;
const IMAGE_DESCRIPTION_DEFAULT_CONTENT_TYPE = 'image/jpeg';
const MAX_IMAGE_DESCRIPTION_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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
    lookupImpl?: typeof dns.lookup;
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

const isPrivateIpv4Address = (address: string): boolean => {
    const octets = address.split('.').map((segment) => Number(segment));
    if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
        return true;
    }

    const [first, second] = octets;

    return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 0) ||
        (first === 192 && second === 168) ||
        (first === 198 && (second === 18 || second === 19))
    );
};

const isPrivateIpv6Address = (address: string): boolean => {
    const normalized = address.toLowerCase();

    return (
        normalized === '::1' ||
        normalized === '::' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb') ||
        normalized.startsWith('::ffff:127.')
    );
};

const isPrivateIpAddress = (address: string): boolean => {
    const family = net.isIP(address);
    if (family === 4) {
        return isPrivateIpv4Address(address);
    }

    if (family === 6) {
        return isPrivateIpv6Address(address);
    }

    return false;
};

const validateSafeImageUrl = async (
    imageUrl: string,
    lookupImpl: typeof dns.lookup
): Promise<URL> => {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(imageUrl);
    } catch {
        throw new Error('Image URL is invalid.');
    }

    if (parsedUrl.protocol !== 'https:') {
        throw new Error('Image URL must use HTTPS.');
    }

    if (parsedUrl.username || parsedUrl.password) {
        throw new Error('Image URL must not include embedded credentials.');
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        throw new Error('Image URL host is not allowed.');
    }

    if (net.isIP(hostname)) {
        if (isPrivateIpAddress(hostname)) {
            throw new Error('Image URL host is not allowed.');
        }

        return parsedUrl;
    }

    let resolvedAddresses: Array<{ address: string }> = [];
    try {
        const lookupResult = await lookupImpl(hostname, {
            all: true,
            verbatim: true,
        });
        resolvedAddresses = Array.isArray(lookupResult)
            ? lookupResult
            : [lookupResult];
    } catch (error) {
        throw new Error(
            `Could not resolve image host "${hostname}": ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (resolvedAddresses.length === 0) {
        throw new Error(`Could not resolve image host "${hostname}".`);
    }

    if (resolvedAddresses.some((entry) => isPrivateIpAddress(entry.address))) {
        throw new Error('Image URL host is not allowed.');
    }

    return parsedUrl;
};

const isRedirectStatus = (status: number): boolean =>
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308;

const safeFetchImageResponse = async (
    imageUrl: string,
    fetchImpl: typeof fetch,
    lookupImpl: typeof dns.lookup,
    signal?: AbortSignal
): Promise<{ response: Response; resolvedUrl: URL }> => {
    let currentUrl = await validateSafeImageUrl(imageUrl, lookupImpl);

    for (
        let redirectCount = 0;
        redirectCount <= MAX_IMAGE_DESCRIPTION_REDIRECTS;
        redirectCount += 1
    ) {
        const response = await fetchImpl(currentUrl.toString(), {
            signal,
            redirect: 'manual',
        });

        if (!isRedirectStatus(response.status)) {
            return {
                response,
                resolvedUrl: currentUrl,
            };
        }

        if (redirectCount === MAX_IMAGE_DESCRIPTION_REDIRECTS) {
            throw new Error('Image URL exceeded the maximum redirect limit.');
        }

        const location = response.headers.get('location');
        if (!location) {
            throw new Error('Image URL redirect response did not include a Location header.');
        }

        currentUrl = await validateSafeImageUrl(
            new URL(location, currentUrl).toString(),
            lookupImpl
        );
    }

    throw new Error('Image URL exceeded the maximum redirect limit.');
};

const fetchImageAsDataUrl = async (
    imageUrl: string,
    fetchImpl: typeof fetch,
    lookupImpl: typeof dns.lookup,
    signal?: AbortSignal
): Promise<string> => {
    const { response, resolvedUrl } = await safeFetchImageResponse(
        imageUrl,
        fetchImpl,
        lookupImpl,
        signal
    );
    if (!response.ok) {
        throw new Error(
            `Failed to download image for description: ${response.status} ${response.statusText}`
        );
    }

    const contentTypeHeader = response.headers.get('content-type');
    const normalizedContentType = contentTypeHeader
        ?.split(';', 1)[0]
        ?.trim()
        ?.toLowerCase();
    const detectedContentType = detectContentTypeFromUrl(resolvedUrl.toString());

    if (
        !normalizedContentType ||
        !normalizedContentType.startsWith('image/')
    ) {
        const hintedType =
            detectedContentType ?? IMAGE_DESCRIPTION_DEFAULT_CONTENT_TYPE;
        throw new Error(
            `Downloaded image response was not an image. Received content-type "${contentTypeHeader ?? 'missing'}" while URL hint was "${hintedType}".`
        );
    }

    const contentLength = response.headers.get('content-length');
    if (
        contentLength &&
        Number.isFinite(Number(contentLength)) &&
        Number(contentLength) > MAX_IMAGE_BYTES
    ) {
        throw new Error(
            `Downloaded image exceeded the maximum size of ${MAX_IMAGE_BYTES} bytes.`
        );
    }

    if (!response.body) {
        throw new Error('Downloaded image response did not include a readable body.');
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        if (!value) {
            continue;
        }

        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error(
                `Downloaded image exceeded the maximum size of ${MAX_IMAGE_BYTES} bytes.`
            );
        }

        chunks.push(Buffer.from(value));
    }

    const base64Image = Buffer.concat(chunks, totalBytes).toString('base64');

    return `data:${normalizedContentType};base64,${base64Image}`;
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
    lookupImpl = dns.lookup,
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
                lookupImpl,
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
