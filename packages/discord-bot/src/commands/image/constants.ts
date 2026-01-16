/**
 * @description: Provides shared constants for the image command and embed limits.
 * @arete-scope: utility
 * @arete-module: ImageCommandConstants
 * @arete-risk: low - Constant drift can cause UI truncation or mismatched defaults.
 * @arete-ethics: low - Constants are non-sensitive configuration values.
 */
// Pull resolved defaults from the central image configuration so every caller
// sees the same values even when operators override them via environment
// variables.
import { imageConfig } from '../../config/imageConfig.js';

export const EMBED_FIELD_VALUE_LIMIT = 1024;
export const EMBED_FOOTER_TEXT_LIMIT = 2048;
export const EMBED_DESCRIPTION_LIMIT = 4096;
export const EMBED_TITLE_LIMIT = 256;
export const EMBED_MAX_FIELDS = 25;
export const EMBED_TOTAL_FIELD_CHAR_LIMIT = 6000;
export const PROMPT_DISPLAY_LIMIT = 512;
export const CLOUDINARY_CONTEXT_VALUE_LIMIT = 950;
export const PARTIAL_IMAGE_LIMIT = 1; // OpenAI's limit is 3. 100 extra tokens per partial image 12/18/25 https://platform.openai.com/docs/guides/image-generation#streaming
export const ANNOTATION_TITLE_LIMIT = EMBED_TITLE_LIMIT;
export const ANNOTATION_DESCRIPTION_LIMIT = EMBED_DESCRIPTION_LIMIT;
export const ANNOTATION_MESSAGE_LIMIT = 2000; // Discord's max is 2000
export const DEFAULT_TEXT_MODEL = imageConfig.defaults.textModel;
export const DEFAULT_IMAGE_MODEL = imageConfig.defaults.imageModel;
export const DEFAULT_IMAGE_QUALITY = imageConfig.defaults.quality;
export const DEFAULT_IMAGE_OUTPUT_FORMAT = imageConfig.defaults.outputFormat;
export const DEFAULT_IMAGE_OUTPUT_COMPRESSION =
    imageConfig.defaults.outputCompression;
export const IMAGE_VARIATION_CUSTOM_ID_PREFIX = 'image:variation:';
export const IMAGE_RETRY_CUSTOM_ID_PREFIX = 'image:retry:';
export const IMAGE_VARIATION_GENERATE_CUSTOM_ID_PREFIX =
    'image:variation:generate:';
export const IMAGE_VARIATION_QUALITY_SELECT_PREFIX = 'image:variation:quality:';
export const IMAGE_VARIATION_IMAGE_MODEL_SELECT_PREFIX =
    'image:variation:image-model:';
export const IMAGE_VARIATION_PROMPT_ADJUST_SELECT_PREFIX =
    'image:variation:prompt-adjust:';
export const IMAGE_VARIATION_ASPECT_SELECT_PREFIX = 'image:variation:aspect:';
export const IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX = 'image:variation:prompt:';
export const IMAGE_VARIATION_PROMPT_INPUT_ID = 'variationPrompt';
export const IMAGE_VARIATION_RESET_PROMPT_CUSTOM_ID_PREFIX =
    'image:variation:reset-prompt:';
export const IMAGE_VARIATION_CANCEL_CUSTOM_ID_PREFIX =
    'image:variation:cancel:';
// When the prompt is already near the embed field budget, skip prompt
// enlargement to avoid duplicate/truncated fields.
export const PROMPT_ADJUSTMENT_MIN_REMAINING_RATIO = 0.2;
