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

const normalizeOptionalEnvString = (
    value: string | undefined
): string | null => {
    if (!value) {
        return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
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

const parseFileOverlay = (
    rawOverlayPath: string,
    projectRoot: string,
    maxOverlayLength: number,
    readFile: (resolvedPath: string) => string
): BotProfilePromptOverlay => {
    const resolvedPath = path.isAbsolute(rawOverlayPath)
        ? rawOverlayPath
        : path.resolve(projectRoot, rawOverlayPath);

    let fileContents = '';
    try {
        fileContents = readFile(resolvedPath);
    } catch {
        return emptyOverlay(resolvedPath);
    }

    const normalizedContents = fileContents.trim();
    if (normalizedContents.length === 0) {
        return emptyOverlay(resolvedPath);
    }

    if (normalizedContents.length > maxOverlayLength) {
        return emptyOverlay(resolvedPath);
    }

    return {
        source: 'file',
        text: normalizedContents,
        path: resolvedPath,
        length: normalizedContents.length,
    };
};

/**
 * Reads bot profile values from env with validation and fail-open defaults.
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

    const inlineOverlay = normalizeOptionalEnvString(
        env.BOT_PROFILE_PROMPT_OVERLAY
    );
    const fileOverlayPath = normalizeOptionalEnvString(
        env.BOT_PROFILE_PROMPT_OVERLAY_PATH
    );

    const promptOverlay = inlineOverlay
        ? parseInlineOverlay(inlineOverlay, maxOverlayLength)
        : fileOverlayPath
          ? parseFileOverlay(
                fileOverlayPath,
                projectRoot,
                maxOverlayLength,
                readFile
            )
          : emptyOverlay();

    return {
        id: parseProfileId(env.BOT_PROFILE_ID),
        displayName: parseProfileDisplayName(env.BOT_PROFILE_DISPLAY_NAME),
        promptOverlay,
    };
};
