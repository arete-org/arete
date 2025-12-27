/**
 * @description: Calls the OpenAI Responses API for image generation and metadata handling.
 * @arete-scope: utility
 * @arete-module: ImageOpenAIClient
 * @arete-risk: high - API failures or misuse can break image delivery and cost controls.
 * @arete-ethics: high - Generates user-visible content with safety and provenance implications.
 */
import { OpenAI } from 'openai';
import type {
    Response,
    ResponseInput,
    ResponseCreateParamsNonStreaming,
    ResponseCreateParamsStreaming,
    Tool,
    ToolChoiceTypes
} from 'openai/resources/responses/responses.js';
import { logger } from '../../utils/logger.js';
import {
    ANNOTATION_DESCRIPTION_LIMIT,
    ANNOTATION_MESSAGE_LIMIT,
    ANNOTATION_TITLE_LIMIT,
    PARTIAL_IMAGE_LIMIT,
    DEFAULT_IMAGE_OUTPUT_COMPRESSION
} from './constants.js';
import { sanitizeForEmbed, truncateForEmbed } from './embed.js';
import { renderPrompt } from '../../utils/env.js';
import { buildDeveloperPrompt } from './prompts.js';
import type {
    ImageBackgroundType,
    ImageGenerationCallWithPrompt,
    ImageQualityType,
    ImageRenderModel,
    ImageSizeType,
    ImageStylePreset,
    ImageTextModel,
    PartialImagePayload,
    AnnotationFields,
    ImageOutputFormat,
    ImageOutputCompression
} from './types.js';
import { mapResponseError } from './errors.js';

type ResponseCreateParams = ResponseCreateParamsNonStreaming;
type ResponseStreamParams = ResponseCreateParamsStreaming;

interface GenerateImageOptions {
    openai: OpenAI;
    prompt: string;
    textModel: ImageTextModel;
    imageModel: ImageRenderModel;
    quality: ImageQualityType;
    size: ImageSizeType;
    background: ImageBackgroundType;
    style: ImageStylePreset;
    username: string;
    nickname: string;
    guildName: string;
    allowPromptAdjustment: boolean;
    outputFormat: ImageOutputFormat;
    outputCompression: ImageOutputCompression;
    followUpResponseId?: string | null;
    onPartialImage?: (payload: PartialImagePayload) => Promise<void> | void;
    stream?: boolean;
}

interface GenerationOutcome {
    response: Response;
    imageCall: ImageGenerationCallWithPrompt;
    finalImageBase64: string;
    partialImages: string[];
    annotations: AnnotationFields;
}

export async function generateImageWithMetadata(options: GenerateImageOptions): Promise<GenerationOutcome> {
    const {
        openai,
        prompt,
        textModel,
        imageModel,
        quality,
        size,
        background,
        style,
        allowPromptAdjustment,
        outputFormat,
        outputCompression,
        followUpResponseId,
        username,
        nickname,
        guildName,
        onPartialImage,
        stream
    } = options;

    const { content: imageSystemPrompt } = renderPrompt('discord.image.system');

    const remainingPromptRatio = calculateRemainingRatio(prompt);

    const input: ResponseInput = [
        {
            role: 'system',
            type: 'message',
            content: [{ type: 'input_text', text: imageSystemPrompt }]
        },
        {
            role: 'developer',
            type: 'message',
            content: [{ type: 'input_text', text: buildDeveloperPrompt({
                allowPromptAdjustment,
                size,
                quality,
                background,
                style,
                username,
                nickname,
                guildName,
                remainingPromptRatio
            }) }]
        },
        {
            role: 'user',
            type: 'message',
            content: [{ type: 'input_text', text: prompt }]
        }
    ];

    const imageTool = createImageGenerationTool({
        model: imageModel,
        quality,
        size,
        background,
        outputFormat,
        outputCompression,
        allowPartialImages: Boolean(onPartialImage)
    });

    const toolChoice: ToolChoiceTypes = { type: 'image_generation' };

    const requestPayload: ResponseCreateParams = {
        model: textModel as ResponseCreateParams['model'],
        input,
        tools: [imageTool],
        tool_choice: toolChoice,
        previous_response_id: followUpResponseId ?? null
    };

    logger.debug(`Request payload: ${JSON.stringify(requestPayload, null, 2)}`);

    const shouldStream = Boolean(stream ?? onPartialImage);
    let response: Response;
    let partials: string[] = [];

    if (shouldStream) {
        const partialImages: string[] = [];
        const streamingPayload: ResponseStreamParams = { ...requestPayload, stream: true };
        const stream = await openai.responses.stream(streamingPayload);

        stream.on('response.image_generation_call.partial_image', event => {
            try {
                partialImages[event.partial_image_index] = event.partial_image_b64;
                if (onPartialImage) {
                    void Promise.resolve(onPartialImage({ index: event.partial_image_index, base64: event.partial_image_b64 }))
                        .catch(error => logger.warn('Failed to process partial image update:', error));
                }
            } catch (error) {
                logger.warn('Unexpected error while handling partial image:', error);
            }
        });

        stream.on('error', (error: unknown) => {
            logger.error('Image generation stream error:', error);
        });

        stream.on('response.failed', event => {
            logger.error('Image generation stream failed:', event.response.error ?? event.response);
        });

        response = await stream.finalResponse();
        partials = partialImages;
    } else {
        response = await openai.responses.create(requestPayload);
        partials = [];
    }

    if (response.error) {
        throw new Error(mapResponseError(response.error));
    }

    const imageGenerationCalls = response.output.filter(
        (output): output is ImageGenerationCallWithPrompt => output.type === 'image_generation_call'
    );

    if (imageGenerationCalls.length === 0) {
        throw new Error('No image generation call found in response. The model may not have decided to generate an image.');
    }

    const imageCallWithResult = imageGenerationCalls.find(call => Boolean(call.result));
    const imageCall = imageCallWithResult ?? imageGenerationCalls[0];
    const imageData = normalizeImageResult(imageCall?.result);

    if (!imageCall || !imageData) {
        throw new Error('No image data found in the image generation call result.');
    }

    logger.debug(`Image generation successful - ID: ${imageCall.id}, Status: ${imageCall.status}`);

    const annotationText = extractFirstTextMessage(response);
    const annotations = parseAnnotationFields(annotationText);

    return {
        response,
        imageCall,
        finalImageBase64: imageData,
        partialImages: partials,
        annotations
    };
}

function createImageGenerationTool(options: {
    model: ImageRenderModel;
    quality: ImageQualityType;
    size: ImageSizeType;
    background: ImageBackgroundType;
    outputFormat: ImageOutputFormat;
    outputCompression: ImageOutputCompression;
    allowPartialImages: boolean;
}): Tool.ImageGeneration {
    // The OpenAI SDK currently narrows the `model` property to only allow the
    // `gpt-image-1` literal. The API accepts additional models (for example the
    // more affordable `gpt-image-1-mini`), so we populate the field and then
    // cast the resulting object back to the SDK's type.
    const tool: Tool.ImageGeneration = {
        type: 'image_generation',
        quality: options.quality,
        size: options.size,
        background: options.background,
        output_format: options.outputFormat,
        // SDK only narrows to "gpt-image-1" literal, but API accepts other models (e.g., gpt-image-1-mini).
        model: options.model as Tool.ImageGeneration['model']
    };

    // OpenAI currently expects PNG requests to use 100 compression; values < 100
    // return a 400. For other formats we clamp to the requested value.
    if (options.outputFormat === 'png') {
        tool.output_compression = 100;
    } else {
        tool.output_compression = clampOutputCompression(options.outputCompression);
    }

    if (options.allowPartialImages) {
        tool.partial_images = PARTIAL_IMAGE_LIMIT;
    }

    return tool;
}

function clampOutputCompression(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_IMAGE_OUTPUT_COMPRESSION;
    }
    return Math.min(100, Math.max(1, Math.round(value)));
}

function calculateRemainingRatio(prompt: string): number {
    const safeLimit = ANNOTATION_MESSAGE_LIMIT; // reuse a conservative limit for free text
    const remaining = Math.max(0, safeLimit - prompt.length);
    return remaining / safeLimit;
}

function normalizeImageResult(result: unknown): string | null {
    if (!result) {
        return null;
    }

    if (typeof result === 'string') {
        return result;
    }

    if (typeof result === 'object') {
        const possible = result as Record<string, unknown>;
        const keys = ['b64_json', 'image_b64', 'base64'];
        for (const key of keys) {
            const value = possible[key];
            if (typeof value === 'string') {
                return value;
            }
        }
    }

    return null;
}

function extractFirstTextMessage(response: Response): string | null {
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
}

function stripJsonFences(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
        const inner = trimmed.replace(/^```json\s*/i, '').replace(/```$/i, '');
        return inner.trim();
    }
    return trimmed;
}

function parseAnnotationFields(rawText: string | null): AnnotationFields {
    if (!rawText) {
        return { title: null, description: null, note: null, adjustedPrompt: null };
    }

    const sanitizedRaw = stripJsonFences(rawText);

    try {
        const parsed = JSON.parse(sanitizedRaw) as Partial<AnnotationFields> & { adjusted_prompt?: string; reflection?: string };
        const title = parsed.title ? truncateForEmbed(sanitizeForEmbed(parsed.title), ANNOTATION_TITLE_LIMIT) : null;
        const description = parsed.description
            ? truncateForEmbed(sanitizeForEmbed(parsed.description), ANNOTATION_DESCRIPTION_LIMIT)
            : null;
        const noteSource = parsed.note ?? (parsed as { reflection?: string }).reflection ?? null;
        const note = noteSource
            ? truncateForEmbed(sanitizeForEmbed(noteSource), ANNOTATION_MESSAGE_LIMIT)
            : null;
        const adjustedPrompt = parsed.adjusted_prompt ?? parsed.adjustedPrompt ?? null;

        return { title, description, note, adjustedPrompt };
    } catch (error) {
        logger.warn('Failed to parse annotation response JSON. Using raw text.', error);
        const note = truncateForEmbed(sanitizeForEmbed(sanitizedRaw), ANNOTATION_MESSAGE_LIMIT);
        return { title: null, description: null, note, adjustedPrompt: null };
    }
}
