/**
 * @description: Verifies that the catchup filter treats common emoji modifier sequences as emoji-only content.
 * @footnote-scope: test
 * @footnote-module: CatchupFilterTests
 * @footnote-risk: low - These tests only validate deterministic catchup heuristics.
 * @footnote-ethics: medium - Correct emoji-only detection helps avoid unnecessary bot replies in human conversations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeConfig } from '../src/config.js';
import type { BotProfileConfig } from '../src/config/profile.js';
import { CatchupFilter } from '../src/utils/CatchupFilter.js';

interface CatchupMessageLike {
    attachments: { size: number };
    author: { bot: boolean };
    content: string;
}

const withProfile = async (
    profile: BotProfileConfig,
    fn: () => Promise<void> | void
): Promise<void> => {
    const mutableRuntimeConfig = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    const previousProfile = mutableRuntimeConfig.profile;
    mutableRuntimeConfig.profile = profile;

    try {
        await fn();
    } finally {
        mutableRuntimeConfig.profile = previousProfile;
    }
};

const createProfile = (
    overrides: Partial<BotProfileConfig> = {}
): BotProfileConfig => ({
    id: 'footnote',
    displayName: 'Footnote',
    mentionAliases: [],
    promptOverlay: {
        source: 'none',
        text: null,
        path: null,
        length: 0,
    },
    ...overrides,
});

function createMessage(content: string): CatchupMessageLike {
    return {
        attachments: { size: 0 },
        author: { bot: false },
        content,
    };
}

function isEmojiOnly(message: CatchupMessageLike): boolean {
    const filter = new CatchupFilter();
    const emojiOnlyMethod = Reflect.get(filter as object, 'isEmojiOnly') as (
        message: CatchupMessageLike
    ) => boolean;

    return emojiOnlyMethod.call(filter, message);
}

test('isEmojiOnly accepts emoji with skin-tone modifiers', () => {
    assert.equal(isEmojiOnly(createMessage('👍🏻')), true);
});

test('isEmojiOnly accepts emoji modifier and ZWJ chains', () => {
    assert.equal(isEmojiOnly(createMessage('👨🏽‍💻 👩🏻‍💻')), true);
});

const createDiscordMessage = (
    content: string,
    overrides: Record<string, unknown> = {}
) =>
    ({
        content,
        createdTimestamp: Date.now(),
        guildId: 'guild-1',
        channelId: 'channel-1',
        attachments: { size: 0 },
        author: {
            id: 'user-1',
            bot: false,
            username: 'Jordan',
        },
        client: {
            user: {
                id: 'bot-1',
                username: 'FootnoteBot',
            },
        },
        mentions: {
            users: {
                has: () => false,
            },
            repliedUser: null,
        },
        ...overrides,
    }) as never;

test('shouldSkipPlanner treats vendor aliases as valid mentions in shared channels', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        async () => {
            const filter = new CatchupFilter();
            const decision = await filter.shouldSkipPlanner(
                createDiscordMessage('hey ari can you explain this bug?'),
                [],
                'guild-1:channel-1'
            );

            assert.equal(decision.skip, false);
        }
    );
});

test('shouldSkipPlanner uses footnote fallback alias when no explicit aliases are configured', async () => {
    await withProfile(createProfile(), async () => {
        const filter = new CatchupFilter();
        const decision = await filter.shouldSkipPlanner(
            createDiscordMessage('footnote can you help with this error?'),
            [],
            'guild-1:channel-1'
        );

        assert.equal(decision.skip, false);
    });
});

test('shouldSkipPlanner blocks substring false positives for plaintext aliases', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        async () => {
            const filter = new CatchupFilter();
            const decision = await filter.shouldSkipPlanner(
                createDiscordMessage('variable naming question'),
                [],
                'guild-1:channel-1'
            );

            assert.equal(decision.skip, true);
            assert.equal(
                decision.reason,
                'Bot not mentioned or addressed in recent context'
            );
        }
    );
});
