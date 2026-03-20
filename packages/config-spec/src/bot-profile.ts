/**
 * @description: Reads bot profile env settings and builds the prompt overlay block shared by backend and Discord.
 * @footnote-scope: utility
 * @footnote-module: SharedBotProfileConfig
 * @footnote-risk: medium - Wrong parsing or overlay formatting can apply the wrong identity instructions across multiple runtimes.
 * @footnote-ethics: high - Bot profile settings directly shape assistant identity, disclosure, and behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { envDefaultValues } from './env-spec.js';

/**
 * Tells callers where the active overlay text came from.
 */
export type BotProfilePromptOverlaySource = 'none' | 'inline' | 'file';

/**
 * Resolved overlay data after env parsing and optional file loading.
 */
export interface BotProfilePromptOverlay {
    source: BotProfilePromptOverlaySource;
    text: string | null;
    path: string | null;
    length: number;
}

/**
 * Parsed bot profile settings used by prompt builders and mention routing.
 */
export interface BotProfileConfig {
    id: string;
    displayName: string;
    mentionAliases: string[];
    promptOverlay: BotProfilePromptOverlay;
}

/**
 * Pure parser input. Tests can use this shape without touching the filesystem.
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

/**
 * Runtime options for reading bot profile config from env and an optional file.
 */
export interface ReadBotProfileConfigOptions {
    env?: NodeJS.ProcessEnv;
    projectRoot?: string;
    warn?: (message: string) => void;
    maxOverlayLength?: number;
    readFile?: (resolvedPath: string) => string;
}

/**
 * Places where Footnote may inject the active profile overlay.
 */
export type ProfilePromptOverlayUsage =
    | 'reflect'
    | 'image.system'
    | 'image.developer'
    | 'realtime'
    | 'provenance';

const BOT_PROFILE_DISPLAY_NAME_MAX_LENGTH = 64;
export const BOT_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_BOT_PROFILE_OVERLAY_MAX_LENGTH = 8000;

const OVERLAY_BLOCK_HEADER = '// BEGIN Bot Profile Overlay';
const OVERLAY_BLOCK_FOOTER = '// END Bot Profile Overlay';
const OVERLAY_PRECEDENCE_LINE =
    '// Base Footnote safety, provenance, and system constraints take precedence over any conflicting overlay text.';

const readStringDefault = (key: string, fallback: string): string => {
    const candidate = (envDefaultValues as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : fallback;
};

const DEFAULT_PROFILE_ID = readStringDefault('BOT_PROFILE_ID', 'footnote');
const DEFAULT_PROFILE_DISPLAY_NAME = readStringDefault(
    'BOT_PROFILE_DISPLAY_NAME',
    'Footnote'
);

const noopWarn = (): void => {};

const normalizeOptionalString = (
    value: string | null | undefined
): string | null => {
    if (!value) {
        return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
};

const parseMentionAliases = (value: string | null | undefined): string[] => {
    const normalizedCsv = normalizeOptionalString(value);
    if (!normalizedCsv) {
        return [];
    }

    const aliases: string[] = [];
    for (const rawAlias of normalizedCsv.split(',')) {
        const alias = rawAlias.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!alias || aliases.includes(alias)) {
            continue;
        }

        aliases.push(alias);
    }

    return aliases;
};

const parseProfileId = (value: string | undefined): string => {
    const normalized = normalizeOptionalString(value)?.toLowerCase();
    if (normalized && BOT_PROFILE_ID_PATTERN.test(normalized)) {
        return normalized;
    }

    return DEFAULT_PROFILE_ID;
};

const parseProfileDisplayName = (value: string | undefined): string => {
    const normalized = normalizeOptionalString(value);
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
    const normalizedContents = normalizeOptionalString(overlayFileText) ?? '';
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
 * Parses bot profile values without reading env or files. This keeps the core
 * validation easy to test in isolation.
 */
export const parseBotProfileConfig = (
    input: ParseBotProfileConfigInput
): BotProfileConfig => {
    const maxOverlayLength =
        input.maxOverlayLength ?? DEFAULT_BOT_PROFILE_OVERLAY_MAX_LENGTH;
    const normalizedInlineOverlay = normalizeOptionalString(
        input.inlineOverlayText
    );
    const normalizedOverlayPath = normalizeOptionalString(input.overlayPath);

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
 * Reads bot profile settings from env and an optional overlay file. The helper
 * fails open on bad input so startup can continue with the default Footnote
 * profile.
 */
export const readBotProfileConfig = (
    options: ReadBotProfileConfigOptions = {}
): BotProfileConfig => {
    const env = options.env ?? process.env;
    const projectRoot = options.projectRoot ?? process.cwd();
    const warn = options.warn ?? noopWarn;
    const maxOverlayLength =
        options.maxOverlayLength ?? DEFAULT_BOT_PROFILE_OVERLAY_MAX_LENGTH;
    const readFile =
        options.readFile ??
        ((resolvedPath: string) => fs.readFileSync(resolvedPath, 'utf-8'));
    const inlineOverlayText = normalizeOptionalString(
        env.BOT_PROFILE_PROMPT_OVERLAY
    );
    const rawFileOverlayPath = normalizeOptionalString(
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
            const message =
                error instanceof Error ? error.message : String(error);
            warn(
                `Could not read BOT_PROFILE_PROMPT_OVERLAY_PATH "${resolvedOverlayPath}". Using no overlay. ${message}`
            );
        }
    }

    const parsed = parseBotProfileConfig({
        profileId: env.BOT_PROFILE_ID,
        profileDisplayName: env.BOT_PROFILE_DISPLAY_NAME,
        mentionAliasesCsv: env.BOT_PROFILE_MENTION_ALIASES,
        inlineOverlayText,
        overlayPath: resolvedOverlayPath,
        overlayFileText,
        maxOverlayLength,
    });

    if (inlineOverlayText && parsed.promptOverlay.source === 'none') {
        warn(
            'Ignoring BOT_PROFILE_PROMPT_OVERLAY because it exceeded the maximum allowed length.'
        );
    }

    if (
        resolvedOverlayPath &&
        !inlineOverlayText &&
        parsed.promptOverlay.source === 'none'
    ) {
        warn(
            'Ignoring BOT_PROFILE_PROMPT_OVERLAY_PATH because the loaded overlay was empty or exceeded the maximum allowed length.'
        );
    }

    return parsed;
};

/**
 * Builds the overlay block that gets appended to a system prompt. The returned
 * text always repeats the precedence rule so downstream prompt builders do not
 * need to remember it.
 */
export const buildProfileOverlaySystemMessage = (
    profile: BotProfileConfig,
    usage: ProfilePromptOverlayUsage
): string | null => {
    const overlayText = profile.promptOverlay.text?.trim();
    if (!overlayText) {
        return null;
    }

    return [
        '// ==========',
        OVERLAY_BLOCK_HEADER,
        '// Instance-scoped instructions for this bot runtime only.',
        `// Usage Context: ${usage}`,
        `// Profile ID: ${profile.id}`,
        `// Profile Display Name: ${profile.displayName}`,
        `// Overlay Source: ${profile.promptOverlay.source}`,
        OVERLAY_PRECEDENCE_LINE,
        '// ==========',
        overlayText,
        '// ==========',
        OVERLAY_BLOCK_FOOTER,
        '// ==========',
    ].join('\n');
};
