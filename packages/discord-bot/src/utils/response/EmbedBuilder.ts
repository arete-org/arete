/**
 * @description: Builds safe Discord embeds with validation against platform limits.
 * @footnote-scope: utility
 * @footnote-module: ResponseEmbedBuilder
 * @footnote-risk: low - Invalid embeds can cause message failures or truncation.
 * @footnote-ethics: low - Presentation logic does not alter content semantics.
 */
import {
    APIEmbed,
    APIEmbedField,
    ColorResolvable,
    EmbedBuilder as DiscordEmbedBuilder,
} from 'discord.js';
import { logger } from '../logger.js';

// Discord API limits
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_FIELD_NAME_LENGTH = 256;
const MAX_FIELD_VALUE_LENGTH = 1024;
const MAX_FIELD_COUNT = 25;

type RGB = [number, number, number];
type HexColor = `#${string}`;

export type EmbedColor = ColorResolvable | RGB | HexColor | number | string;

export interface EmbedAuthorOptions {
    name: string;
    iconUrl?: string;
    url?: string;
}

export interface EmbedFieldOptions {
    name: string;
    value: string;
    inline?: boolean;
}

export interface EmbedFooterOptions {
    text: string;
    iconUrl?: string;
}

export interface EmbedImageOptions {
    url: string;
    height?: number;
    width?: number;
}

export interface EmbedThumbnailOptions {
    url: string;
    height?: number;
    width?: number;
}

export class EmbedBuilder {
    private embed: DiscordEmbedBuilder;
    private fields: APIEmbedField[] = [];

    constructor() {
        this.embed = new DiscordEmbedBuilder();
    }

    private validateLength(
        value: string,
        maxLength: number,
        fieldName: string
    ): boolean {
        if (value.length > maxLength) {
            logger.warn(
                `[EmbedBuilder] ${fieldName} exceeds maximum length of ${maxLength} characters`
            );
            return false;
        }
        return true;
    }

    private validateUrl(url: string, fieldName: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            logger.warn(
                `[EmbedBuilder] Invalid URL provided for ${fieldName}: ${url}`
            );
            return false;
        }
    }

    // Core Methods
    public setTitle(title: string): this {
        if (this.validateLength(title, MAX_TITLE_LENGTH, 'title')) {
            this.embed.setTitle(title);
        }
        return this;
    }

    public setDescription(description: string): this {
        if (
            this.validateLength(
                description,
                MAX_DESCRIPTION_LENGTH,
                'description'
            )
        ) {
            this.embed.setDescription(description);
        }
        return this;
    }

    public setURL(url: string): this {
        if (this.validateUrl(url, 'URL')) {
            this.embed.setURL(url);
        }
        return this;
    }

    public setColor(color: EmbedColor): this {
        try {
            this.embed.setColor(color as ColorResolvable);
        } catch {
            logger.warn(`[EmbedBuilder] Invalid color provided: ${color}`);
        }
        return this;
    }

    // Author
    public setAuthor(author: EmbedAuthorOptions): this {
        if (!author?.name) {
            logger.warn('[EmbedBuilder] Author name is required');
            return this;
        }

        if (
            author.iconUrl &&
            !this.validateUrl(author.iconUrl, 'author icon URL')
        ) {
            return this;
        }

        if (author.url && !this.validateUrl(author.url, 'author URL')) {
            return this;
        }

        this.embed.setAuthor({
            name: author.name,
            iconURL: author.iconUrl,
            url: author.url,
        });
        return this;
    }

    // Footer
    public setFooter(footer: EmbedFooterOptions): this {
        if (!footer?.text) {
            logger.warn('[EmbedBuilder] Footer text is required');
            return this;
        }

        if (
            footer.iconUrl &&
            !this.validateUrl(footer.iconUrl, 'footer icon URL')
        ) {
            return this;
        }

        this.embed.setFooter({
            text: footer.text,
            iconURL: footer.iconUrl,
        });
        return this;
    }

    // Image
    public setImage(image: EmbedImageOptions): this {
        if (this.validateUrl(image.url, 'image URL')) {
            this.embed.setImage(image.url);
        }
        return this;
    }

    // Thumbnail
    public setThumbnail(thumbnail: EmbedThumbnailOptions): this {
        if (this.validateUrl(thumbnail.url, 'thumbnail URL')) {
            this.embed.setThumbnail(thumbnail.url);
        }
        return this;
    }

    // Timestamp
    public setTimestamp(timestamp: number | Date | null = new Date()): this {
        this.embed.setTimestamp(timestamp);
        return this;
    }

    // Fields
    public addField(field: EmbedFieldOptions): this {
        if (this.fields.length >= MAX_FIELD_COUNT) {
            logger.warn(
                `[EmbedBuilder] Maximum of ${MAX_FIELD_COUNT} fields reached`
            );
            return this;
        }

        if (!field.name || !field.value) {
            logger.warn('[EmbedBuilder] Field name and value are required');
            return this;
        }

        const isValidName = this.validateLength(
            field.name,
            MAX_FIELD_NAME_LENGTH,
            'field name'
        );
        const isValidValue = this.validateLength(
            field.value,
            MAX_FIELD_VALUE_LENGTH,
            'field value'
        );

        if (isValidName && isValidValue) {
            this.fields.push({
                name: field.name,
                value: field.value,
                inline: field.inline ?? false,
            });
            this.embed.setFields(this.fields);
        }

        return this;
    }

    public addFields(...fields: EmbedFieldOptions[]): this {
        fields.forEach((field) => this.addField(field));
        return this;
    }

    public addBlankField(inline = false): this {
        return this.addField({
            name: '\u200b',
            value: '\u200b',
            inline,
        });
    }

    // Build the final embed
    public build(): DiscordEmbedBuilder {
        return this.embed;
    }

    /**
     * Converts the embed to a plain JavaScript object.
     * @returns {APIEmbed} The embed data as a plain object
     */
    public toJSON(): APIEmbed {
        const data: APIEmbed = {};

        if (this.embed.data.title) data.title = this.embed.data.title;
        if (this.embed.data.description)
            data.description = this.embed.data.description;
        if (this.embed.data.color) data.color = this.embed.data.color;
        if (this.embed.data.fields?.length)
            data.fields = [...this.embed.data.fields];
        if (this.embed.data.timestamp)
            data.timestamp = this.embed.data.timestamp;
        if (this.embed.data.thumbnail)
            data.thumbnail = { ...this.embed.data.thumbnail };
        if (this.embed.data.image) data.image = { ...this.embed.data.image };
        if (this.embed.data.author) data.author = { ...this.embed.data.author };
        if (this.embed.data.footer) data.footer = { ...this.embed.data.footer };

        return data;
    }

    // Static methods
    public static from(embed: APIEmbed): EmbedBuilder {
        const builder = new EmbedBuilder();
        const discordEmbed = DiscordEmbedBuilder.from(embed);
        builder.embed = discordEmbed;
        if (embed.fields) {
            builder.fields = [...embed.fields];
        }
        return builder;
    }

    // Static factory method for creating embeds with options
    public static create({
        title,
        description,
        color,
        author,
        footer,
        image,
        thumbnail,
        fields = [],
        timestamp = true,
    }: {
        title?: string;
        description?: string;
        color?: EmbedColor;
        author?: EmbedAuthorOptions;
        footer?: EmbedFooterOptions;
        image?: EmbedImageOptions;
        thumbnail?: EmbedThumbnailOptions;
        fields?: EmbedFieldOptions[];
        timestamp?: boolean;
    } = {}): EmbedBuilder {
        const embed = new EmbedBuilder();

        if (title) embed.setTitle(title);
        if (description) embed.setDescription(description);
        if (color) embed.setColor(color);
        if (author) embed.setAuthor(author);
        if (footer) embed.setFooter(footer);
        if (image) embed.setImage(image);
        if (thumbnail) embed.setThumbnail(thumbnail);
        if (fields.length > 0) {
            // Only add up to MAX_FIELD_COUNT fields
            fields
                .slice(0, MAX_FIELD_COUNT)
                .forEach((field) => embed.addField(field));
        }
        if (timestamp) embed.setTimestamp();

        return embed;
    }
}

export default EmbedBuilder;

