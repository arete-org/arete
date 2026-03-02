/**
 * @description: Builds and executes OpenAI vision requests to describe images for Discord users.
 * @footnote-scope: utility
 * @footnote-module: ImageDescriptionProcessor
 * @footnote-risk: medium - Failures can block image understanding or inflate costs.
 * @footnote-ethics: medium - Image descriptions may expose sensitive content if mishandled.
 */

import OpenAI from 'openai';
import fetch from 'node-fetch';
import { lookup as lookupMimeType } from 'mime-types';
import { logger } from '../logger.js';
import {
    IMAGE_DESCRIPTION_CONFIG,
    IMAGE_DESCRIPTION_PROMPT_TEMPLATE,
} from '../../constants/imageProcessing.js';
import type { ImageDescriptionModelType } from '../../constants/imageProcessing.js';
import type { OpenAIResponse } from '../openaiService.js';

export interface ImageDescriptionStructuredPayload {
    key_elements: string[];
    table_markdown?: string[];
    [key: string]: unknown;
}

export interface ImageDescriptionPayload {
    summary: string;
    detected_type: string;
    extracted_text: string[];
    structured: ImageDescriptionStructuredPayload;
    confidence: string;
    notes?: string;
}

export interface ImageDescriptionUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface ImageDescriptionResult {
    response: OpenAIResponse;
    usage: ImageDescriptionUsage | null;
}

export interface ImageDescriptionRequest {
    imageUrl: string;
    context?: string;
    model: ImageDescriptionModelType;
}

const DESCRIPTION_TOOL_NAME = 'describe_image';

const IMAGE_DESCRIPTION_TOOL_SCHEMA: OpenAI.Chat.Completions.ChatCompletionTool =
    {
        type: 'function',
        function: {
            name: DESCRIPTION_TOOL_NAME,
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
                    'confidence',
                ],
                properties: {
                    summary: {
                        type: 'string',
                        description: '1-2 sentence neutral caption.',
                    },
                    detected_type: {
                        type: 'string',
                        description:
                            'Short label (1-3 words). Choose the dominant type and avoid compound labels. Examples: screenshot, document, ui, grid puzzle, chart, photo, meme, other.',
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
                                    'Short bullets capturing the most salient elements. Use an empty array if none.',
                            },
                            table_markdown: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                },
                                description:
                                    'Optional markdown tables, verbatim including empty slots, as strings when tables are clearly visible.',
                            },
                        },
                        description:
                            'Always include structured.key_elements. Use additional fields only when structure is obvious (grids/tables/forms/axes/sections).',
                    },
                    confidence: {
                        type: 'string',
                        description:
                            'Short qualifier (1-2 words). Examples: high, medium, low, marginal.',
                    },
                    notes: {
                        type: 'string',
                        description:
                            'Optional; one short sentence on unreadable/ambiguous parts.',
                    },
                },
            },
        },
    };

/**
 * Build the prompt by inserting the optional context while preserving the
 * canonical prompt text in constants.
 */
function buildImageDescriptionPrompt(context?: string): string {
    const trimmedContext = context?.trim();
    const normalizedContext =
        trimmedContext && trimmedContext.length > 0 ? trimmedContext : '(none)';
    const contextBlock =
        trimmedContext && trimmedContext.length > 0
            ? `Additional context: ${trimmedContext}`
            : '';
    const keyElementsTarget = `${IMAGE_DESCRIPTION_CONFIG.keyElementsMin}-${IMAGE_DESCRIPTION_CONFIG.keyElementsMax}`;

    return IMAGE_DESCRIPTION_PROMPT_TEMPLATE.replace(
        '{{context}}',
        normalizedContext
    )
        .replace('{{context_block}}', contextBlock)
        .replace('{{key_elements_target}}', keyElementsTarget)
        .replace(
            '{{extracted_text_limit}}',
            String(IMAGE_DESCRIPTION_CONFIG.extractedTextLineLimit)
        );
}

type AnyToolCall =
    | OpenAI.Chat.Completions.ChatCompletionMessageToolCall
    | OpenAI.Chat.Completions.ChatCompletionMessageCustomToolCall;

function isFunctionToolCall(
    toolCall: AnyToolCall | undefined
): toolCall is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall {
    return !!toolCall && toolCall.type === 'function';
}

function parseToolPayload(
    toolCall: AnyToolCall | undefined
): ImageDescriptionPayload | null {
    if (!isFunctionToolCall(toolCall) || !toolCall.function?.arguments) {
        return null;
    }

    try {
        const parsed = JSON.parse(
            toolCall.function.arguments
        ) as ImageDescriptionPayload;
        return normalizeImageDescriptionPayload(parsed);
    } catch (error) {
        logger.warn('Failed to parse image description tool output.', error);
        return null;
    }
}

function normalizeImageDescriptionPayload(
    payload: ImageDescriptionPayload
): ImageDescriptionPayload {
    const structuredValue = payload?.structured ?? {};
    const structuredRecord =
        structuredValue && typeof structuredValue === 'object'
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

    return {
        ...payload,
        structured: {
            ...structuredRecord,
            key_elements: keyElements,
            ...(tableMarkdown ? { table_markdown: tableMarkdown } : {}),
        },
    };
}

/**
 * Download and base64-encode an image so it can be sent to the vision API.
 */
async function fetchImageAsBase64(
    imageUrl: string
): Promise<{ base64Image: string; contentType: string }> {
    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const imageBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(imageBuffer);
    const base64Image = buffer.toString('base64');
    const headerContentType = response.headers.get('content-type');
    const inferredContentType = detectContentTypeFromUrl(imageUrl);
    const contentType =
        headerContentType ||
        inferredContentType ||
        IMAGE_DESCRIPTION_CONFIG.defaultContentType;

    logger.debug('Downloaded image for description', {
        imageUrl,
        contentType,
        byteLength: imageBuffer.byteLength,
    });

    return { base64Image, contentType };
}

function detectContentTypeFromUrl(imageUrl: string): string | null {
    const lookupResult = lookupMimeType(imageUrl);
    if (!lookupResult || typeof lookupResult !== 'string') {
        return null;
    }

    return lookupResult;
}

/**
 * Execute the vision request and normalize the OpenAI response into the shared
 * OpenAIResponse format used across the bot.
 */
export async function generateImageDescriptionRequest(
    openai: OpenAI,
    request: ImageDescriptionRequest
): Promise<ImageDescriptionResult> {
    const { imageUrl, context, model } = request;
    const { base64Image, contentType } = await fetchImageAsBase64(imageUrl);
    const prompt = buildImageDescriptionPrompt(context);

    // OpenAI SDK types lag behind vision content parts; cast to keep compile-time strictness elsewhere.
    const visionMessage = {
        role: 'user',
        content: [
            {
                type: 'text',
                text: prompt,
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${contentType};base64,${base64Image}`,
                    detail: IMAGE_DESCRIPTION_CONFIG.detail,
                },
            },
        ],
    } as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam;

    const chatResponse = await openai.chat.completions.create({
        model,
        max_completion_tokens: IMAGE_DESCRIPTION_CONFIG.maxTokens,
        tools: [IMAGE_DESCRIPTION_TOOL_SCHEMA],
        tool_choice: {
            type: 'function',
            function: {
                name: DESCRIPTION_TOOL_NAME,
            },
        },
        messages: [visionMessage],
    });

    const choice = chatResponse.choices[0];
    const toolCall = choice.message.tool_calls?.find(
        (call) =>
            isFunctionToolCall(call) &&
            call.function?.name === DESCRIPTION_TOOL_NAME
    );
    const payload = parseToolPayload(toolCall);
    if (!payload) {
        throw new Error(
            `Image description model "${model}" did not return a valid tool payload. This model may not support tool calls in chat completions; configure IMAGE_DESCRIPTION_CONFIG.model to a tool-capable model (e.g., gpt-4o-mini).`
        );
    }
    const payloadJson = JSON.stringify(payload);

    // Keep the response compatible with existing downstream usage by embedding JSON as the content.
    const imageDescriptionResponse: OpenAIResponse = {
        normalizedText: payloadJson,
        message: {
            role: 'assistant',
            content: payloadJson,
        },
        finish_reason: choice.finish_reason || 'stop',
        usage: chatResponse.usage
            ? {
                  input_tokens: chatResponse.usage.prompt_tokens || 0,
                  output_tokens: chatResponse.usage.completion_tokens || 0,
                  total_tokens: chatResponse.usage.total_tokens ?? 0,
              }
            : undefined,
    };

    return {
        response: imageDescriptionResponse,
        usage: chatResponse.usage
            ? {
                  promptTokens: chatResponse.usage.prompt_tokens || 0,
                  completionTokens: chatResponse.usage.completion_tokens || 0,
                  totalTokens: chatResponse.usage.total_tokens ?? 0,
              }
            : null,
    };
}

