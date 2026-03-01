/**
 * @description: Formats image command metadata into Discord embed-safe text.
 * @footnote-scope: utility
 * @footnote-module: ImageEmbedFormatting
 * @footnote-risk: low - Formatting errors can truncate or mislabel embed details.
 * @footnote-ethics: low - Embeds present metadata without additional processing.
 */
import { EmbedBuilder, type APIEmbedField } from 'discord.js';
import {
    CLOUDINARY_CONTEXT_VALUE_LIMIT,
    EMBED_DESCRIPTION_LIMIT,
    EMBED_FIELD_VALUE_LIMIT,
    EMBED_FOOTER_TEXT_LIMIT,
    PROMPT_DISPLAY_LIMIT,
} from './constants.js';

export function sanitizeForEmbed(value: string): string {
    return value.replace(/\0/g, '');
}

export function truncateForEmbed(
    value: string,
    limit: number,
    options: { includeTruncationNote?: boolean } = {}
): string {
    const sanitized = sanitizeForEmbed(value);

    if (sanitized.length <= limit) {
        return sanitized;
    }

    const ellipsis = '…';
    const truncationNote = options.includeTruncationNote
        ? '\n*(truncated)*'
        : '';
    const availableLength = Math.max(
        0,
        limit - ellipsis.length - truncationNote.length
    );
    const truncated = sanitized.slice(0, availableLength);
    return `${truncated}${ellipsis}${truncationNote}`;
}

export function setEmbedFooterText(embed: EmbedBuilder, text: string) {
    embed.setFooter({ text: truncateForEmbed(text, EMBED_FOOTER_TEXT_LIMIT) });
}

export function setEmbedDescription(embed: EmbedBuilder, description: string) {
    embed.setDescription(
        truncateForEmbed(description, EMBED_DESCRIPTION_LIMIT)
    );
}

export function setOrAddEmbedField(
    embed: EmbedBuilder,
    name: string,
    value: string,
    {
        inline = false,
        includeTruncationNote = false,
        maxLength = EMBED_FIELD_VALUE_LIMIT,
    }: {
        inline?: boolean;
        includeTruncationNote?: boolean;
        maxLength?: number;
    } = {}
) {
    const formattedValue = truncateForEmbed(value, maxLength, {
        includeTruncationNote,
    });
    const field: APIEmbedField = inline
        ? { name, value: formattedValue, inline }
        : { name, value: formattedValue };

    const fields = embed.data.fields ?? [];
    const index = fields.findIndex(
        (existingField) => existingField.name === name
    );

    if (index >= 0) {
        embed.spliceFields(index, 1, field);
    } else {
        embed.addFields(field);
    }
}

export interface PromptFieldOptions {
    label: string;
    fullContentUrl?: string;
    whenMissing?: string;
}

export function buildPromptFieldValue(
    value: string | null | undefined,
    options: PromptFieldOptions
): string {
    const fallback = options.whenMissing ?? 'None';

    if (!value || !value.trim()) {
        return truncateForEmbed(fallback, EMBED_FIELD_VALUE_LIMIT);
    }

    const sanitized = sanitizeForEmbed(value);
    const exceedsThreshold = sanitized.length > PROMPT_DISPLAY_LIMIT;
    let preview = exceedsThreshold
        ? truncateForEmbed(sanitized, PROMPT_DISPLAY_LIMIT, {
              includeTruncationNote: true,
          })
        : sanitized;

    if (exceedsThreshold && options.fullContentUrl) {
        // TODO: Add a link to the image on Cloudinary with metadata visible. This currently points to just the image, which is not very useful.
        //preview = `${preview}\n[View full ${options.label}](${options.fullContentUrl})`;
    }

    return truncateForEmbed(preview, EMBED_FIELD_VALUE_LIMIT);
}

export function clampForCloudinary(value: string): string {
    const sanitized = sanitizeForEmbed(value);
    if (sanitized.length <= CLOUDINARY_CONTEXT_VALUE_LIMIT) {
        return sanitized;
    }
    return sanitized.slice(0, CLOUDINARY_CONTEXT_VALUE_LIMIT);
}

export function chunkString(value: string, chunkSize: number): string[] {
    const sanitized = sanitizeForEmbed(value);
    if (!sanitized) {
        return [];
    }

    const chunks: string[] = [];
    let index = 0;
    while (index < sanitized.length) {
        chunks.push(sanitized.slice(index, index + chunkSize));
        index += chunkSize;
    }
    return chunks;
}

