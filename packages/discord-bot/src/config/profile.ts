/**
 * @description: Re-exports the shared bot profile parser for Discord startup code and adapts warnings into the Discord logger.
 * @footnote-scope: utility
 * @footnote-module: BotProfileConfig
 * @footnote-risk: medium - Wrong wiring here can make Discord mention routing and prompt composition use the wrong profile settings.
 * @footnote-ethics: medium - Profile configuration shapes assistant identity, disclosure, and overlay behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    readBotProfileConfig as readSharedBotProfileConfig,
    type ReadBotProfileConfigOptions as SharedReadBotProfileConfigOptions,
} from '@footnote/config-spec/bot-profile';
import { bootstrapLogger } from '../utils/logger.js';

export type {
    BotProfileConfig,
    BotProfilePromptOverlay,
    BotProfilePromptOverlaySource,
    ParseBotProfileConfigInput,
} from '@footnote/config-spec/bot-profile';
export {
    BOT_PROFILE_ID_PATTERN,
    DEFAULT_BOT_PROFILE_OVERLAY_MAX_LENGTH,
    parseBotProfileConfig,
} from '@footnote/config-spec/bot-profile';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const profileLogger =
    typeof bootstrapLogger.child === 'function'
        ? bootstrapLogger.child({ module: 'botProfileConfig' })
        : bootstrapLogger;

/**
 * Discord keeps the same override hooks as before, but the parsing logic now
 * lives in one shared helper.
 */
export interface ReadBotProfileConfigOptions extends Omit<
    SharedReadBotProfileConfigOptions,
    'projectRoot' | 'warn'
> {
    projectRoot?: string;
}

/**
 * Reads the shared bot profile config and sends fail-open warnings through the
 * Discord bootstrap logger.
 */
export const readBotProfileConfig = (
    options: ReadBotProfileConfigOptions = {}
) =>
    readSharedBotProfileConfig({
        env: options.env,
        projectRoot: options.projectRoot ?? DEFAULT_PROJECT_ROOT,
        maxOverlayLength: options.maxOverlayLength,
        readFile:
            options.readFile ??
            ((resolvedPath: string) => fs.readFileSync(resolvedPath, 'utf-8')),
        warn: (message) => {
            profileLogger.warn(message);
        },
    });
