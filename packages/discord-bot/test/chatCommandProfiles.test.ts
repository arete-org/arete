/**
 * @description: Tests startup profile-choice hydration for /chat slash command.
 * @footnote-scope: test
 * @footnote-module: ChatCommandProfilesTests
 * @footnote-risk: low - Covers bootstrap-only choice hydration behavior.
 * @footnote-ethics: low - This affects command UX, not generation policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

import { botApi } from '../src/api/botApi.js';
import type { Command } from '../src/commands/BaseCommand.js';
import { applyChatCommandProfileChoices } from '../src/utils/chatCommandProfiles.js';

type ProfileCommand = Command & {
    setProfileChoices?: (
        profiles: Array<{ id: string; description?: string }>
    ) => void;
};

test('applies up to 25 profile choices when backend registry fetch succeeds', async () => {
    const originalGetChatProfiles = botApi.getChatProfiles;
    const seenProfiles: Array<{ id: string; description?: string }> = [];
    const command: ProfileCommand = {
        data: {} as never,
        execute: async () => undefined,
        setProfileChoices: (profiles) => {
            seenProfiles.push(...profiles);
        },
    };
    const commands = new Collection<string, Command>([['chat', command]]);

    botApi.getChatProfiles = (async () => ({
        profiles: Array.from({ length: 30 }, (_, index) => ({
            id: `profile-${index + 1}`,
            description: `Profile ${index + 1}`,
        })),
    })) as typeof botApi.getChatProfiles;

    try {
        await applyChatCommandProfileChoices(commands);
        assert.equal(seenProfiles.length, 25);
        assert.equal(seenProfiles[0]?.id, 'profile-1');
        assert.equal(seenProfiles[24]?.id, 'profile-25');
    } finally {
        botApi.getChatProfiles = originalGetChatProfiles;
    }
});

test('fails open when profile registry fetch fails and keeps free-text mode', async () => {
    const originalGetChatProfiles = botApi.getChatProfiles;
    let setterCalls = 0;
    const command: ProfileCommand = {
        data: {} as never,
        execute: async () => undefined,
        setProfileChoices: () => {
            setterCalls += 1;
        },
    };
    const commands = new Collection<string, Command>([['chat', command]]);

    botApi.getChatProfiles = (async () => {
        throw new Error('backend unavailable');
    }) as typeof botApi.getChatProfiles;

    try {
        await applyChatCommandProfileChoices(commands);
        assert.equal(setterCalls, 0);
    } finally {
        botApi.getChatProfiles = originalGetChatProfiles;
    }
});
