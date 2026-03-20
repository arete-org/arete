/**
 * @description: Verifies realtime engagement mention scoring uses shared profile alias logic.
 * @footnote-scope: test
 * @footnote-module: RealtimeEngagementFilterTests
 * @footnote-risk: low - These tests validate deterministic scoring behavior only.
 * @footnote-ethics: high - Mention scoring controls when the bot speaks in active conversations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeConfig } from '../src/config.js';
import type { BotProfileConfig } from '../src/config/profile.js';
import {
    RealtimeEngagementFilter,
    type EngagementContext,
} from '../src/engagement/RealtimeEngagementFilter.js';

const originalProfile = runtimeConfig.profile;

const withProfile = async (
    profile: BotProfileConfig,
    fn: () => Promise<void> | void
): Promise<void> => {
    const mutableRuntimeConfig = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    mutableRuntimeConfig.profile = profile;

    try {
        await fn();
    } finally {
        mutableRuntimeConfig.profile = originalProfile;
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

const createFilter = () =>
    new RealtimeEngagementFilter(
        runtimeConfig.engagementWeights,
        runtimeConfig.engagementPreferences
    );

const createContext = (
    content: string,
    overrides: Record<string, unknown> = {}
): EngagementContext =>
    ({
        channelKey: 'guild-1:channel-1',
        recentMessages: [],
        channelMetrics: null,
        message: {
            id: 'message-1',
            content,
            guildId: 'guild-1',
            channelId: 'channel-1',
            author: {
                id: 'user-1',
                username: 'Jordan',
                bot: false,
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
            reference: undefined,
            ...overrides,
        },
    }) as never;

type RealtimeFilterPrivateAccess = {
    scoreMention: (context: EngagementContext) => number;
    scoreHumanActivity: (context: EngagementContext) => number;
    scoreBotNoise: (context: EngagementContext) => number;
};

test('scoreMention returns 0.9 for explicit vendor aliases', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        () => {
            const filter =
                createFilter() as unknown as RealtimeFilterPrivateAccess;
            assert.equal(filter.scoreMention(createContext('hey ari')), 0.9);
        }
    );
});

test('scoreMention falls back to footnote display-name aliases when explicit aliases are absent', async () => {
    await withProfile(createProfile(), () => {
        const filter = createFilter() as unknown as RealtimeFilterPrivateAccess;
        assert.equal(filter.scoreMention(createContext('hey footnote')), 0.9);
    });
});

test('scoreMention includes the live Discord username as a fallback alias', async () => {
    await withProfile(
        createProfile({
            id: 'vendor-bot',
            displayName: 'Vendor Bot',
            mentionAliases: ['ari'],
        }),
        () => {
            const filter =
                createFilter() as unknown as RealtimeFilterPrivateAccess;
            assert.equal(
                filter.scoreMention(
                    createContext('hello footnotebot', {
                        client: {
                            user: {
                                id: 'bot-1',
                                username: 'FootnoteBot',
                            },
                        },
                    })
                ),
                0.9
            );
        }
    );
});

test('scoreMention blocks substring false positives for vendor aliases', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        () => {
            const filter =
                createFilter() as unknown as RealtimeFilterPrivateAccess;
            assert.equal(
                filter.scoreMention(createContext('variable naming')),
                0
            );
        }
    );
});

test('scoreMention still treats direct mentions and replies as full-strength signals', async () => {
    await withProfile(createProfile(), () => {
        const filter = createFilter() as unknown as RealtimeFilterPrivateAccess;

        assert.equal(
            filter.scoreMention(
                createContext('hello', {
                    mentions: {
                        users: {
                            has: () => true,
                        },
                        repliedUser: null,
                    },
                })
            ),
            1
        );

        assert.equal(
            filter.scoreMention(
                createContext('replying now', {
                    reference: {
                        messageId: 'prior-message',
                        channelId: 'channel-1',
                    },
                    mentions: {
                        users: {
                            has: () => false,
                        },
                        repliedUser: {
                            id: 'bot-1',
                        },
                    },
                })
            ),
            1
        );
    });
});

test('human and bot activity scoring prefers the recent fetched window over stale retained metrics', () => {
    const filter = createFilter() as unknown as RealtimeFilterPrivateAccess;
    const context = {
        ...createContext('latest human message'),
        recentMessages: [
            {
                author: { bot: true },
                createdTimestamp: 1,
            },
            {
                author: { bot: true },
                createdTimestamp: 2,
            },
            {
                author: { bot: true },
                createdTimestamp: 3,
            },
            {
                author: { bot: false },
                createdTimestamp: 4,
            },
        ],
        channelMetrics: {
            windowTotalMessages: 20,
            windowBotMessages: 0,
            windowHumanMessages: 20,
            lastEngagementScore: 0,
            lastActivity: Date.now(),
            flags: [],
        },
    } as unknown as EngagementContext;

    assert.equal(filter.scoreHumanActivity(context), 0.4);
    assert.equal(filter.scoreBotNoise(context), 0.4);
});

test('scoreBotNoise drops when the current recent window becomes bot-heavy', () => {
    const filter = createFilter() as unknown as RealtimeFilterPrivateAccess;
    const context = {
        ...createContext('another bot message', {
            author: {
                id: 'bot-a',
                username: 'Bot A',
                bot: true,
            },
        }),
        recentMessages: [
            {
                author: { bot: true },
                createdTimestamp: 1,
            },
            {
                author: { bot: true },
                createdTimestamp: 2,
            },
            {
                author: { bot: true },
                createdTimestamp: 3,
            },
            {
                author: { bot: false },
                createdTimestamp: 4,
            },
        ],
    } as unknown as EngagementContext;

    assert.ok(Math.abs(filter.scoreBotNoise(context) - 0.2) < 0.000001);
});
