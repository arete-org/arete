/**
 * @description: Re-exports the shared bot profile parser for backend startup code and keeps the backend warning contract explicit.
 * @footnote-scope: utility
 * @footnote-module: BackendBotProfileConfig
 * @footnote-risk: medium - Wrong wiring here can stop backend prompt assembly from seeing the intended profile settings.
 * @footnote-ethics: medium - Profile configuration shapes the identity and instructions used during backend-owned prompt assembly.
 */

import {
    readBotProfileConfig as readSharedBotProfileConfig,
    type ReadBotProfileConfigOptions as SharedReadBotProfileConfigOptions,
} from '@footnote/config-spec/bot-profile';
import type { WarningSink } from './types.js';

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

/**
 * Backend startup passes an explicit env snapshot, project root, and warning
 * sink so config assembly stays deterministic.
 */
export interface ReadBotProfileConfigOptions extends Omit<
    SharedReadBotProfileConfigOptions,
    'warn'
> {
    env: NodeJS.ProcessEnv;
    projectRoot: string;
    warn: WarningSink;
}

/**
 * Reads the shared bot profile config using backend-owned warning handling.
 */
export const readBotProfileConfig = ({
    env,
    projectRoot,
    warn,
    maxOverlayLength,
    readFile,
}: ReadBotProfileConfigOptions) =>
    readSharedBotProfileConfig({
        env,
        projectRoot,
        warn,
        maxOverlayLength,
        readFile,
    });
