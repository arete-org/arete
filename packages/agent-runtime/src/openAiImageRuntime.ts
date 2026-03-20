/**
 * @description: Calls the OpenAI image API behind Footnote's shared image runtime boundary.
 * @footnote-scope: core
 * @footnote-module: OpenAiImageRuntime
 * @footnote-risk: high - Incorrect request or result mapping here can break image delivery, follow-up chaining, or cost accounting.
 * @footnote-ethics: high - This adapter generates user-visible media and must preserve Footnote-owned transparency and safety cues.
 */
import OpenAI from 'openai';
import {
    estimateOpenAIImageGenerationCost,
    estimateOpenAITextCost,
} from '@footnote/contracts/pricing';
import type {
    Response,
    ResponseCreateParamsNonStreaming,
    ResponseCreateParamsStreaming,
    ResponseImageGenCallPartialImageEvent,
    ResponseInput,
    ResponseOutputItem,
    Tool,
    ToolChoiceTypes,
} from 'openai/resources/responses/responses.js';
import type {
    ImageGenerationAnnotations,
    ImageGenerationRequest,
    ImageGenerationResult,
    ImageGenerationRuntime,
} from './index.js';

type ResponseCreateParams = ResponseCreateParamsNonStreaming;
type ResponseStreamParams = ResponseCreateParamsStreaming;

const DEFAULT_IMAGE_OUTPUT_COMPRESSION = 100;
const PARTIAL_IMAGE_LIMIT = 1;

type ResponseCreateParamsImageTool = Tool.ImageGeneration;

type OpenAiImageGenerationCall = ResponseOutputItem.ImageGenerationCall & {
    revised_prompt?: string | null;
    style_preset?: string | null;
};

type OpenAiImageRuntimeResponseClient = {
    createResponse: (
        request: ResponseCreateParams,
        options?: { signal?: AbortSignal }
    ) => Promise<Pick<Response, 'id' | 'error' | 'output' | 'usage'>>;
    streamResponse?: (
        request: ResponseStreamParams,
        options?: { signal?: AbortSignal }
    ) => Promise<OpenAiImageRuntimeResponseStream>;
};

type OpenAiImageRuntimeResponseStream = {
    on(
        event: 'response.image_generation_call.partial_image',
        listener: (event: ResponseImageGenCallPartialImageEvent) => void
    ): void;
    on(event: 'error', listener: (error: unknown) => void): void;
    on(
        event: 'response.failed',
        listener: (event: { response?: Pick<Response, 'error'> }) => void
    ): void;
    finalResponse(): Promise<
        Pick<Response, 'id' | 'error' | 'output' | 'usage'>
    >;
};

type OpenAiImageRuntimeDebugData = Record<string, unknown>;

export interface OpenAiImageRuntimeLogger {
    debug?: (message: string, data?: OpenAiImageRuntimeDebugData) => void;
    warn?: (message: string, data?: OpenAiImageRuntimeDebugData) => void;
    error?: (message: string, data?: OpenAiImageRuntimeDebugData) => void;
}

export interface CreateOpenAiImageRuntimeOptions {
    apiKey?: string;
    client?: OpenAiImageRuntimeResponseClient;
    logger?: OpenAiImageRuntimeLogger;
    kind?: string;
    requestTimeoutMs?: number;
}

type RedactedResponseInputText = {
    type: string;
    text?: string;
};

const redactResponseInput = (
    input: ResponseInput
): Array<{
    role?: string | null;
    type?: string | null;
    content?: RedactedResponseInputText[];
}> =>
    input.map((entry) => {
        const candidate = entry as unknown as Record<string, unknown>;
        const content = Array.isArray(candidate.content)
            ? candidate.content.map((part) =>
                  part && typeof part === 'object' && 'text' in part
                      ? {
                            ...part,
                            text:
                                typeof part.text === 'string'
                                    ? '[REDACTED_PROMPT_TEXT]'
                                    : part.text,
                        }
                      : part
              )
            : undefined;

        return {
            role:
                typeof candidate.role === 'string' || candidate.role === null
                    ? candidate.role
                    : undefined,
            type:
                typeof candidate.type === 'string' || candidate.type === null
                    ? candidate.type
                    : undefined,
            content,
        };
    });

const clampOutputCompression = (value: number): number => {
    if (!Number.isFinite(value)) {
        return DEFAULT_IMAGE_OUTPUT_COMPRESSION;
    }

    return Math.min(100, Math.max(1, Math.round(value)));
};

const createImageGenerationTool = (
    request: Pick<
        ImageGenerationRequest,
        | 'imageModel'
        | 'quality'
        | 'size'
        | 'background'
        | 'outputFormat'
        | 'outputCompression'
    > & {
        allowPartialImages: boolean;
    }
): ResponseCreateParamsImageTool => {
    const tool: ResponseCreateParamsImageTool = {
        type: 'image_generation',
        quality: request.quality,
        size: request.size,
        background: request.background,
        output_format: request.outputFormat,
        model: request.imageModel as ResponseCreateParamsImageTool['model'],
    };

    if (request.outputFormat === 'png') {
        tool.output_compression = 100;
    } else {
        tool.output_compression = clampOutputCompression(
            request.outputCompression
        );
    }

    if (request.allowPartialImages) {
        tool.partial_images = PARTIAL_IMAGE_LIMIT;
    }

    return tool;
};

const normalizeImageResult = (result: unknown): string | null => {
    if (!result) {
        return null;
    }

    if (typeof result === 'string') {
        return result;
    }

    if (typeof result === 'object') {
        const candidate = result as Record<string, unknown>;
        for (const key of ['b64_json', 'image_b64', 'base64']) {
            const value = candidate[key];
            if (typeof value === 'string') {
                return value;
            }
        }
    }

    return null;
};

const isImageGenerationCall = (
    output: ResponseOutputItem
): output is ResponseOutputItem.ImageGenerationCall =>
    output.type === 'image_generation_call';

const toOpenAiImageGenerationCall = (
    output: ResponseOutputItem.ImageGenerationCall
): OpenAiImageGenerationCall => output as OpenAiImageGenerationCall;

const extractFirstTextMessage = (
    response: Pick<Response, 'output'>
): string | null => {
    for (const output of response.output ?? []) {
        if (output.type !== 'message') {
            continue;
        }

        for (const content of output.content ?? []) {
            if (content.type === 'output_text' && content.text) {
                return content.text;
            }
        }
    }

    return null;
};

const stripJsonFences = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
        return trimmed
            .replace(/^```json\s*/i, '')
            .replace(/```$/i, '')
            .trim();
    }

    return trimmed;
};

const parseAnnotationFields = (
    rawText: string | null
): ImageGenerationAnnotations => {
    if (!rawText) {
        return {
            title: null,
            description: null,
            note: null,
            adjustedPrompt: null,
        };
    }

    const sanitizedRaw = stripJsonFences(rawText);

    try {
        const parsed = JSON.parse(
            sanitizedRaw
        ) as Partial<ImageGenerationAnnotations> & {
            adjusted_prompt?: string;
            reflection?: string;
        };

        return {
            title: typeof parsed.title === 'string' ? parsed.title : null,
            description:
                typeof parsed.description === 'string'
                    ? parsed.description
                    : null,
            note:
                typeof parsed.note === 'string'
                    ? parsed.note
                    : typeof parsed.reflection === 'string'
                      ? parsed.reflection
                      : null,
            adjustedPrompt:
                typeof parsed.adjusted_prompt === 'string'
                    ? parsed.adjusted_prompt
                    : typeof parsed.adjustedPrompt === 'string'
                      ? parsed.adjustedPrompt
                      : null,
        };
    } catch {
        return {
            title: null,
            description: null,
            note: sanitizedRaw,
            adjustedPrompt: null,
        };
    }
};

const mapResponseError = (
    error: NonNullable<Pick<Response, 'error'>['error']>
): string => {
    switch (error.code) {
        case 'image_content_policy_violation':
            return 'OpenAI safety filters blocked this prompt. Please modify the prompt and try again.';
        case 'rate_limit_exceeded':
            return 'OpenAI rate limit hit while generating the image. Please try again.';
        case 'invalid_prompt':
            return `OpenAI could not process the prompt: ${error.message}`;
        case 'server_error':
            return 'OpenAI had a temporary issue generating the image. Please try again.';
        case 'invalid_image':
        case 'invalid_image_format':
        case 'invalid_base64_image':
        case 'invalid_image_url':
        case 'image_too_large':
        case 'image_too_small':
        case 'image_parse_error':
        case 'invalid_image_mode':
        case 'image_file_too_large':
        case 'unsupported_image_media_type':
        case 'empty_image_file':
        case 'failed_to_download_image':
        case 'image_file_not_found':
            return `Image processing error: ${error.message}`;
        default:
            return `OpenAI error: ${error.message}`;
    }
};

const createDefaultResponseClient = (
    apiKey: string
): OpenAiImageRuntimeResponseClient => {
    const openai = new OpenAI({ apiKey });

    return {
        async createResponse(request, options) {
            return openai.responses.create(request, options);
        },
        async streamResponse(request, options) {
            return openai.responses.stream(request, options);
        },
    };
};

const createRequestAbortContext = (
    requestSignal: AbortSignal | undefined,
    requestTimeoutMs: number | undefined
): {
    signal?: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
} => {
    if (
        requestTimeoutMs === undefined ||
        !Number.isFinite(requestTimeoutMs) ||
        requestTimeoutMs <= 0
    ) {
        return {
            signal: requestSignal,
            cleanup: () => undefined,
            didTimeout: () => false,
        };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, requestTimeoutMs);

    let abortListener: (() => void) | null = null;
    if (requestSignal) {
        if (requestSignal.aborted) {
            controller.abort(requestSignal.reason);
        } else {
            abortListener = () => controller.abort(requestSignal.reason);
            requestSignal.addEventListener('abort', abortListener, {
                once: true,
            });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutHandle);
            if (requestSignal && abortListener) {
                requestSignal.removeEventListener('abort', abortListener);
            }
        },
        didTimeout: () => timedOut,
    };
};

const normalizeResponseToImageResult = (
    request: ImageGenerationRequest,
    response: Pick<Response, 'id' | 'error' | 'output' | 'usage'>,
    startedAt: number,
    partialImageCount: number = 0
): ImageGenerationResult => {
    if (response.error) {
        throw new Error(mapResponseError(response.error));
    }

    const imageGenerationCalls = response.output
        .filter(isImageGenerationCall)
        .map(toOpenAiImageGenerationCall);
    if (imageGenerationCalls.length === 0) {
        throw new Error('No image generation call found in the response.');
    }

    const imageCall =
        imageGenerationCalls.find((call) => Boolean(call.result)) ??
        imageGenerationCalls[0];
    const finalImageBase64 = normalizeImageResult(imageCall.result);
    if (!finalImageBase64) {
        throw new Error('No image data found in the image generation result.');
    }

    const annotationText = extractFirstTextMessage(response);
    const annotations = parseAnnotationFields(annotationText);
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const totalTokens =
        response.usage?.total_tokens ?? inputTokens + outputTokens;
    const successfulImageCount =
        imageGenerationCalls.filter((call) => Boolean(call.result)).length || 1;
    const textCost = estimateOpenAITextCost(
        request.textModel,
        inputTokens,
        outputTokens
    );
    const imageCost = estimateOpenAIImageGenerationCost({
        model: request.imageModel,
        quality: request.quality,
        size: request.size,
        imageCount: successfulImageCount,
        partialImageCount,
    });

    return {
        responseId: response.id ?? null,
        textModel: request.textModel,
        imageModel: request.imageModel,
        revisedPrompt:
            annotations.adjustedPrompt ?? imageCall.revised_prompt ?? null,
        finalStyle: imageCall.style_preset ?? request.style,
        annotations,
        finalImageBase64,
        outputFormat: request.outputFormat,
        outputCompression:
            request.outputFormat === 'png'
                ? 100
                : clampOutputCompression(request.outputCompression),
        usage: {
            inputTokens,
            outputTokens,
            totalTokens,
            imageCount: successfulImageCount,
        },
        costs: {
            text: textCost.totalCost,
            image: imageCost.totalCost,
            total: textCost.totalCost + imageCost.totalCost,
            perImage: imageCost.perImageCost,
        },
        generationTimeMs: Date.now() - startedAt,
    };
};

const createOpenAiImageRuntime = ({
    apiKey,
    client,
    logger,
    kind = 'openai-image',
    requestTimeoutMs,
}: CreateOpenAiImageRuntimeOptions): ImageGenerationRuntime => {
    const responseClient =
        client ??
        (apiKey
            ? createDefaultResponseClient(apiKey)
            : (() => {
                  throw new Error(
                      'OpenAI image runtime requires either apiKey or client.'
                  );
              })());

    return {
        kind,
        async generateImage(
            request: ImageGenerationRequest
        ): Promise<ImageGenerationResult> {
            const startedAt = Date.now();
            const abortContext = createRequestAbortContext(
                request.signal,
                requestTimeoutMs
            );
            const input: ResponseInput = [
                {
                    role: 'system',
                    type: 'message',
                    content: [
                        {
                            type: 'input_text',
                            text: request.systemPrompt,
                        },
                    ],
                },
                {
                    role: 'developer',
                    type: 'message',
                    content: [
                        {
                            type: 'input_text',
                            text: request.developerPrompt,
                        },
                    ],
                },
                {
                    role: 'user',
                    type: 'message',
                    content: [{ type: 'input_text', text: request.prompt }],
                },
            ];

            const toolChoice: ToolChoiceTypes = {
                type: 'image_generation',
            };
            const requestPayload: ResponseCreateParams = {
                model: request.textModel as ResponseCreateParams['model'],
                input,
                tools: [
                    createImageGenerationTool({
                        ...request,
                        allowPartialImages: Boolean(request.onPartialImage),
                    }),
                ],
                tool_choice: toolChoice,
                previous_response_id: request.followUpResponseId ?? null,
            };

            logger?.debug?.('Image runtime request payload (redacted).', {
                model: requestPayload.model,
                previousResponseId: requestPayload.previous_response_id,
                toolCount: requestPayload.tools?.length ?? 0,
                inputMessageCount: input.length,
                systemPromptLength: request.systemPrompt.length,
                developerPromptLength: request.developerPrompt.length,
                userPromptLength: request.prompt.length,
                payload: {
                    ...requestPayload,
                    input: redactResponseInput(input),
                },
            });

            const shouldStream = Boolean(
                request.stream ?? request.onPartialImage
            );
            try {
                const streamedResult = shouldStream
                    ? await (async () => {
                          if (!responseClient.streamResponse) {
                              throw new Error(
                                  'OpenAI image runtime client does not support streaming.'
                              );
                          }

                          const stream = await responseClient.streamResponse(
                              {
                                  ...requestPayload,
                                  stream: true,
                              },
                              { signal: abortContext.signal }
                          );
                          let partialImageCount = 0;
                          let partialImageQueue = Promise.resolve();
                          stream.on(
                              'response.image_generation_call.partial_image',
                              (event) => {
                                  partialImageCount += 1;
                                  if (!request.onPartialImage) {
                                      return;
                                  }

                                  partialImageQueue = partialImageQueue
                                      .then(() =>
                                          request.onPartialImage?.({
                                              index: event.partial_image_index,
                                              base64: event.partial_image_b64,
                                          })
                                      )
                                      .catch((error) => {
                                          logger?.warn?.(
                                              'Image runtime partial-image callback failed.',
                                              {
                                                  error:
                                                      error instanceof Error
                                                          ? error.message
                                                          : String(error),
                                              }
                                          );
                                      });
                              }
                          );
                          stream.on('error', (error) => {
                              logger?.error?.('Image runtime stream error.', {
                                  error:
                                      error instanceof Error
                                          ? error.message
                                          : String(error),
                              });
                          });
                          stream.on('response.failed', (event) => {
                              if (!event.response?.error) {
                                  return;
                              }

                              logger?.error?.(
                                  'Image runtime stream reported a failed response.',
                                  {
                                      code: event.response.error.code,
                                  }
                              );
                          });

                          try {
                              const response = await stream.finalResponse();
                              await partialImageQueue;
                              return {
                                  response,
                                  partialImageCount,
                              };
                          } catch (error) {
                              await partialImageQueue;
                              throw error;
                          }
                      })()
                    : {
                          response: await responseClient.createResponse(
                              requestPayload,
                              { signal: abortContext.signal }
                          ),
                          partialImageCount: 0,
                      };

                if (streamedResult.response.error) {
                    logger?.error?.(
                        'Image runtime response contained an error.',
                        {
                            code: streamedResult.response.error.code,
                        }
                    );
                }

                return normalizeResponseToImageResult(
                    request,
                    streamedResult.response,
                    startedAt,
                    streamedResult.partialImageCount
                );
            } catch (error) {
                if (
                    abortContext.didTimeout() &&
                    error instanceof Error &&
                    error.name === 'AbortError'
                ) {
                    throw new Error(
                        `Image-generation request timed out after ${requestTimeoutMs}ms`
                    );
                }

                throw error;
            } finally {
                abortContext.cleanup();
            }
        },
    };
};

export {
    createOpenAiImageRuntime,
    createDefaultResponseClient,
    mapResponseError,
    normalizeResponseToImageResult,
    parseAnnotationFields,
    redactResponseInput,
};
export type {
    OpenAiImageRuntimeResponseClient,
    OpenAiImageRuntimeResponseStream,
};
