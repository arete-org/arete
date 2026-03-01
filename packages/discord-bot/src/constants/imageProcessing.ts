/**
 * @description: Shared prompt templates for image processing tasks.
 * @footnote-scope: utility
 * @footnote-module: ImageProcessingConstants
 * @footnote-risk: moderate - Prompt changes can alter vision outputs or cost patterns.
 * @footnote-ethics: moderate - Prompt wording affects extracted content and privacy handling.
 */

import type OpenAI from 'openai';
import type { GPT5ModelType, OmniModelType } from '../utils/pricing.js';

type ImageDetailLevel = NonNullable<
    OpenAI.Chat.Completions.ChatCompletionContentPartImage.ImageURL['detail']
>;

/**
 * Template for the image description prompt. Use the placeholders to inject
 * runtime context without reformatting the base instructions.
 */
export const IMAGE_DESCRIPTION_PROMPT_TEMPLATE = `You are an image parsing tool for a Discord assistant.

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

export type ImageDescriptionModelType = GPT5ModelType | OmniModelType;

export interface ImageDescriptionConfig {
    model: ImageDescriptionModelType;
    detail: ImageDetailLevel;
    maxTokens: number;
    defaultContentType: string;
    keyElementsMin: number;
    keyElementsMax: number;
    extractedTextLineLimit: number;
}

/**
 * Centralized defaults for image description requests. Keep these conservative
 * to reduce cost and keep outputs terse for Discord metadata consumers.
 */
export const IMAGE_DESCRIPTION_CONFIG: ImageDescriptionConfig = {
    model: 'gpt-4o-mini', // Tool-capable multimodal model
    detail: 'auto', // High-detail vision helps with OCR and UI elements (auto/low/high).
    maxTokens: 16384, // Cap output size to keep costs bounded (16384=max).
    defaultContentType: 'image/jpeg', // Discord attachments usually resolve to a concrete MIME type.
    keyElementsMin: 3, // Ensures we capture enough elements for downstream context.
    keyElementsMax: 7, // Avoids overly long bullet lists that bloat metadata.
    extractedTextLineLimit: 20, // Keeps OCR dumps short enough for embeds and logs.
};

