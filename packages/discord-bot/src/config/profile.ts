/**
 * @description: Parses bot profile env configuration into a typed object used by vendoring flows.
 * @footnote-scope: utility
 * @footnote-module: BotProfileConfig
 * @footnote-risk: medium - Incorrect parsing can apply the wrong profile identity or overlay source.
 * @footnote-ethics: medium - Profile configuration shapes assistant identity and disclosure behavior.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { envDefaultValues } from '@footnote/config-spec';
import { bootstrapLogger } from '../utils/logger.js';

/**
 * Overlay source selected for the active bot profile prompt behavior.
 * none = no prompting provided; use default Footnote persona
 * inline = prompting provided by env as a string
 * file = prompting provided in a separate file
 */
export type BotProfilePromptOverlaySource = 'none' | 'inline' | 'file';

/**
 * Resolved overlay configuration derived from env and optional file loading.
 */
export interface BotProfilePromptOverlay {
    source: BotProfilePromptOverlaySource;
    text: string | null;
    path: string | null;
    length: number;
}

/**
 * Parsed bot profile configuration derived from environment variables.
 */
export interface BotProfileConfig {
    id: string;
    displayName: string;
    mentionAliases: string[];
    promptOverlay: BotProfilePromptOverlay;
}

/**
 * Tunables and dependency overrides used by startup code and tests.
 */
export interface ReadBotProfileConfigOptions {
    env?: NodeJS.ProcessEnv;
    projectRoot?: string;
    maxOverlayLength?: number;
    readFile?: (resolvedPath: string) => string;
}

/**
 * Pure parse input that separates validation logic from filesystem/env reads.
 */
export interface ParseBotProfileConfigInput {
    profileId?: string;
    profileDisplayName?: string;
    mentionAliasesCsv?: string | null;
    inlineOverlayText?: string | null;
    overlayPath?: string | null;
    overlayFileText?: string | null;
    maxOverlayLength?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const BOT_PROFILE_DISPLAY_NAME_MAX_LENGTH = 64;
export const BOT_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_BOT_PROFILE_OVERLAY_MAX_LENGTH = 8000;
const DEFAULT_PROFILE_ID_FALLBACK = 'footnote';
const DEFAULT_PROFILE_DISPLAY_NAME_FALLBACK = 'Footnote';

const readStringDefault = (key: string, fallback: string): string => {
    const candidate = (envDefaultValues as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : fallback;
};

const DEFAULT_PROFILE_ID = readStringDefault(
    'BOT_PROFILE_ID',
    DEFAULT_PROFILE_ID_FALLBACK
);
const DEFAULT_PROFILE_DISPLAY_NAME = readStringDefault(
    'BOT_PROFILE_DISPLAY_NAME',
    DEFAULT_PROFILE_DISPLAY_NAME_FALLBACK
);
const profileLogger =
    typeof bootstrapLogger.child === 'function'
        ? bootstrapLogger.child({ module: 'botProfileConfig' })
        : bootstrapLogger;

const normalizeOptionalEnvString = (
    value: string | undefined
): string | null => {
    if (!value) {
        return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
};

const normalizeMentionAlias = (value: string): string | null => {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
    return normalized.length > 0 ? normalized : null;
};

const parseMentionAliases = (value: string | null | undefined): string[] => {
    const normalizedCsv = normalizeOptionalEnvString(value ?? undefined);
    if (!normalizedCsv) {
        return [];
    }

    const aliases: string[] = [];
    for (const rawAlias of normalizedCsv.split(',')) {
        const alias = normalizeMentionAlias(rawAlias);
        if (!alias || aliases.includes(alias)) {
            continue;
        }

        aliases.push(alias);
    }

    return aliases;
};

const parseProfileId = (value: string | undefined): string => {
    const normalized = normalizeOptionalEnvString(value)?.toLowerCase();
    if (normalized && BOT_PROFILE_ID_PATTERN.test(normalized)) {
        return normalized;
    }

    return DEFAULT_PROFILE_ID;
};

const parseProfileDisplayName = (value: string | undefined): string => {
    const normalized = normalizeOptionalEnvString(value);
    if (
        normalized &&
        normalized.length <= BOT_PROFILE_DISPLAY_NAME_MAX_LENGTH
    ) {
        return normalized;
    }

    return DEFAULT_PROFILE_DISPLAY_NAME;
};

const emptyOverlay = (
    overlayPath: string | null = null
): BotProfilePromptOverlay => ({
    source: 'none',
    text: null,
    path: overlayPath,
    length: 0,
});

const parseInlineOverlay = (
    inlineOverlay: string,
    maxOverlayLength: number
): BotProfilePromptOverlay => {
    if (inlineOverlay.length > maxOverlayLength) {
        return emptyOverlay();
    }

    return {
        source: 'inline',
        text: inlineOverlay,
        path: null,
        length: inlineOverlay.length,
    };
};

const parseFileOverlayText = (
    overlayPath: string,
    overlayFileText: string | null,
    maxOverlayLength: number
): BotProfilePromptOverlay => {
    const normalizedContents =
        normalizeOptionalEnvString(overlayFileText ?? undefined) ?? '';
    if (normalizedContents.length === 0) {
        return emptyOverlay(overlayPath);
    }

    if (normalizedContents.length > maxOverlayLength) {
        return emptyOverlay(overlayPath);
    }

    return {
        source: 'file',
        text: normalizedContents,
        path: overlayPath,
        length: normalizedContents.length,
    };
};

/**
 * Pure parser for bot profile configuration.
 */
export const parseBotProfileConfig = (
    input: ParseBotProfileConfigInput
): BotProfileConfig => {
    const maxOverlayLength =
        input.maxOverlayLength ?? DEFAULT_BOT_PROFILE_OVERLAY_MAX_LENGTH;
    const normalizedInlineOverlay = normalizeOptionalEnvString(
        input.inlineOverlayText ?? undefined
    );
    const normalizedOverlayPath = normalizeOptionalEnvString(
        input.overlayPath ?? undefined
    );

    const promptOverlay = normalizedInlineOverlay
        ? parseInlineOverlay(normalizedInlineOverlay, maxOverlayLength)
        : normalizedOverlayPath
          ? parseFileOverlayText(
                normalizedOverlayPath,
                input.overlayFileText ?? null,
                maxOverlayLength
            )
          : emptyOverlay();

    return {
        id: parseProfileId(input.profileId),
        displayName: parseProfileDisplayName(input.profileDisplayName),
        mentionAliases: parseMentionAliases(input.mentionAliasesCsv),
        promptOverlay,
    };
};

/**
 * Reads env/path/file inputs then delegates validation to parseBotProfileConfig.
 */
export const readBotProfileConfig = (
    options: ReadBotProfileConfigOptions = {}
): BotProfileConfig => {
    const env = options.env ?? process.env;
    const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
    const maxOverlayLength =
        options.maxOverlayLength ?? DEFAULT_BOT_PROFILE_OVERLAY_MAX_LENGTH;
    const readFile =
        options.readFile ??
        ((resolvedPath: string) => fs.readFileSync(resolvedPath, 'utf-8'));
    const inlineOverlayText = normalizeOptionalEnvString(
        env.BOT_PROFILE_PROMPT_OVERLAY
    );

    const rawFileOverlayPath = normalizeOptionalEnvString(
        env.BOT_PROFILE_PROMPT_OVERLAY_PATH
    );
    const resolvedOverlayPath = rawFileOverlayPath
        ? path.isAbsolute(rawFileOverlayPath)
            ? rawFileOverlayPath
            : path.resolve(projectRoot, rawFileOverlayPath)
        : null;

    let overlayFileText: string | null = null;
    if (resolvedOverlayPath && !inlineOverlayText) {
        try {
            overlayFileText = readFile(resolvedOverlayPath);
        } catch (error) {
            profileLogger.warn('Failed to load bot profile overlay file.', {
                overlayPath: resolvedOverlayPath,
                error:
                    error instanceof Error ? error.message : String(error),
            });
            overlayFileText = null;
        }
    }

    return parseBotProfileConfig({
        profileId: env.BOT_PROFILE_ID,
        profileDisplayName: env.BOT_PROFILE_DISPLAY_NAME,
        mentionAliasesCsv: env.BOT_PROFILE_MENTION_ALIASES,
        inlineOverlayText,
        overlayPath: resolvedOverlayPath,
        overlayFileText,
        maxOverlayLength,
    });
};
