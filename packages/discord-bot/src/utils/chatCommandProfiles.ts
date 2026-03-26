/**
 * @description: Fetches backend chat profile options and applies them to the /chat command at startup.
 * @footnote-scope: utility
 * @footnote-module: ChatCommandProfiles
 * @footnote-risk: medium - Broken startup hydration can reduce model-switching ergonomics.
 * @footnote-ethics: low - This only affects slash-command option UX, not core generation behavior.
 */
import type { Collection } from 'discord.js';
import type { ChatProfileOption } from '@footnote/contracts/web';
import { botApi } from '../api/botApi.js';
import { logger } from './logger.js';
import type { Command } from '../commands/BaseCommand.js';

const MAX_PROFILE_CHOICES = 25;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 500;

type ChatCommandWithProfiles = Command & {
    setProfileChoices?: (profiles: ChatProfileOption[]) => void;
};

type ApplyChatCommandProfileChoicesOptions = {
    maxAttempts?: number;
    retryDelayMs?: number;
};

const wait = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, durationMs);
    });

/**
 * Loads profile choices and applies them to /chat.
 * Fail-open behavior:
 * - fetch failure => keep free-text profile option
 * - no /chat command => no-op
 */
export const applyChatCommandProfileChoices = async (
    commands: Collection<string, Command>,
    {
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    }: ApplyChatCommandProfileChoicesOptions = {}
): Promise<void> => {
    const chatCommand = commands.get('chat') as
        | ChatCommandWithProfiles
        | undefined;
    if (!chatCommand?.setProfileChoices) {
        return;
    }

    const attemptCount = Math.max(1, Math.floor(maxAttempts));
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
        try {
            const response = await botApi.getChatProfiles();
            const profiles = response.profiles ?? [];
            if (profiles.length === 0) {
                logger.warn(
                    'No chat profiles returned for /chat command choices; keeping profile_id as free-text.'
                );
                return;
            }

            const truncatedProfiles = profiles.slice(0, MAX_PROFILE_CHOICES);
            if (profiles.length > MAX_PROFILE_CHOICES) {
                logger.warn(
                    'Chat profile list exceeds Discord choice limit; truncating /chat profile choices.',
                    {
                        totalProfiles: profiles.length,
                        maxChoices: MAX_PROFILE_CHOICES,
                    }
                );
            }

            chatCommand.setProfileChoices(truncatedProfiles);
            logger.info('Applied /chat profile choices from backend catalog.', {
                profileChoiceCount: truncatedProfiles.length,
                attempts: attempt,
            });
            return;
        } catch (error) {
            const isLastAttempt = attempt >= attemptCount;
            if (isLastAttempt) {
                logger.warn(
                    'Failed to load /chat profile choices; keeping profile_id as free-text.',
                    {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        attempts: attempt,
                    }
                );
                return;
            }

            logger.warn('Retrying /chat profile choice fetch after failure.', {
                error: error instanceof Error ? error.message : String(error),
                attempt,
                nextAttempt: attempt + 1,
            });
            await wait(Math.max(0, retryDelayMs * attempt));
        }
    }
};
