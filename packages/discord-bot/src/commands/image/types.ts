/**
 * @description: Defines the shared model and metadata types used by the Discord image command.
 * @footnote-scope: interface
 * @footnote-module: ImageTypes
 * @footnote-risk: low - Type drift here can make the Discord image UI disagree with backend validation.
 * @footnote-ethics: low - These types document shape and ownership but do not change behavior by themselves.
 */
import type { ResponseOutputItem } from 'openai/resources/responses/responses.js';
import {
    internalImageRenderModels,
    internalImageTextModels,
    supportedImageOutputFormats,
    type InternalImageRenderModelId,
    type InternalImageTextModelId,
    type SupportedImageOutputFormat,
} from '@footnote/contracts/providers';
import type {
    ImageGenerationQuality,
    ImageGenerationSize,
} from '../../utils/pricing.js';

export type ImageTextModel = InternalImageTextModelId;
export type ImageRenderModel = InternalImageRenderModelId;
export type ImageQualityType = ImageGenerationQuality;
export type ImageSizeType = ImageGenerationSize;
export type ImageBackgroundType = 'auto' | 'transparent' | 'opaque';
export type ImageOutputFormat = SupportedImageOutputFormat;
export type ImageOutputCompression = number;

/**
 * Text models exposed by the Discord image command. This list comes from the
 * shared provider registry so the UI stays aligned with trusted-route
 * validation.
 */
export const imageTextModels =
    internalImageTextModels satisfies readonly ImageTextModel[];

/**
 * Image render models exposed by the Discord image command.
 */
export const imageRenderModels =
    internalImageRenderModels satisfies readonly ImageRenderModel[];

/**
 * Output formats accepted by the Discord image command.
 */
export const imageOutputFormats =
    supportedImageOutputFormats satisfies readonly ImageOutputFormat[];

export const imageQualities = [
    'low',
    'medium',
    'high',
    'auto',
] as const satisfies readonly ImageQualityType[];

export type ImageStylePreset =
    | 'natural'
    | 'vivid'
    | 'photorealistic'
    | 'cinematic'
    | 'oil_painting'
    | 'watercolor'
    | 'digital_painting'
    | 'line_art'
    | 'sketch'
    | 'cartoon'
    | 'anime'
    | 'comic'
    | 'pixel_art'
    | 'cyberpunk'
    | 'fantasy_art'
    | 'surrealist'
    | 'minimalist'
    | 'vintage'
    | 'noir'
    | '3d_render'
    | 'steampunk'
    | 'abstract'
    | 'pop_art'
    | 'dreamcore'
    | 'isometric'
    | 'unspecified';

export interface ImageGenerationCallWithPrompt
    extends ResponseOutputItem.ImageGenerationCall {
    revised_prompt?: string | null;
    style_preset?: ImageStylePreset | null;
}

/**
 * Small annotation bundle attached to completed image results.
 */
export interface AnnotationFields {
    title: string | null;
    description: string | null;
    note: string | null;
    adjustedPrompt?: string | null;
}

/**
 * One streamed preview image emitted before the final artifact is ready.
 */
export interface PartialImagePayload {
    index: number;
    base64: string;
}

/**
 * Usage data preserved on uploaded image metadata.
 */
export interface CloudinaryUsageMetadata {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    imageCount: number;
    combinedInputTokens: number;
    combinedOutputTokens: number;
    combinedTotalTokens: number;
}

/**
 * Cost data preserved on uploaded image metadata.
 */
export interface CloudinaryCostMetadata {
    text: number;
    image: number;
    total: number;
    perImage: number;
}

/**
 * Metadata persisted alongside one uploaded image result so retries,
 * variations, and trace surfaces can reconstruct what happened.
 */
export interface UploadMetadata {
    originalPrompt: string;
    revisedPrompt?: string | null;
    title?: string | null;
    description?: string | null;
    noteMessage?: string | null;
    textModel: ImageTextModel;
    imageModel: ImageRenderModel;
    outputFormat: ImageOutputFormat;
    outputCompression?: ImageOutputCompression;
    quality: ImageQualityType;
    size: ImageSizeType;
    background: ImageBackgroundType;
    style: ImageStylePreset;
    startTime: number;
    usage: CloudinaryUsageMetadata;
    cost: CloudinaryCostMetadata;
}
