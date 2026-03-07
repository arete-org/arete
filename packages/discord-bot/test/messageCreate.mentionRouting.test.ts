/**
 * @description: Verifies MessageCreate catchup routing uses shared profile aliases consistently.
 * @footnote-scope: test
 * @footnote-module: MessageCreateMentionRoutingTests
 * @footnote-risk: medium - Routing regressions can make the bot miss valid mentions or reply too aggressively.
 * @footnote-ethics: high - Mention routing determines when the bot joins a conversation and must remain predictable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeConfig } from '../src/config.js';
import type { BotProfileConfig } from '../src/config/profile.js';
import { MessageCreate } from '../src/events/MessageCreate.js';

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

const createEvent = () =>
    new MessageCreate({
        openai: { apiKey: 'test-key' },
        openaiService: {
            async generateSpeech() {
                return 'tts.mp3';
            },
        } as never,
        costEstimator: null,
    });

const createMessage = (
    content: string,
    overrides: Record<string, unknown> = {}
) =>
    ({
        id: 'message-1',
        content,
        guildId: 'guild-1',
        channelId: 'channel-1',
        createdTimestamp: Date.now(),
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
        reference: undefined,
        channel: {
            id: 'channel-1',
            type: 'GUILD_TEXT',
            isThread: () => false,
            isTextBased: () => true,
            messages: {
                fetch: async () => new Map<string, unknown>(),
            },
        },
        reply: async () => undefined,
        ...overrides,
    }) as never;

test('execute routes vendored plaintext aliases through the lower catchup threshold', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as {
                realtimeFilter: unknown;
                contextManager: unknown;
                channelMessageCounters: Map<
                    string,
                    { count: number; lastUpdated: number }
                >;
                catchupFilter: {
                    shouldSkipPlanner: (
                        message: unknown,
                        recentMessages: unknown[],
                        channelKey: string
                    ) => Promise<{ skip: boolean; reason: string }>;
                    RECENT_MESSAGE_WINDOW: number;
                };
                messageProcessor: {
                    processMessage: (
                        message: unknown,
                        directReply: boolean,
                        trigger: string
                    ) => Promise<void>;
                };
            };
            const processCalls: Array<{
                directReply: boolean;
                trigger: string;
            }> = [];

            eventAccess.realtimeFilter = null;
            eventAccess.contextManager = null;
            eventAccess.channelMessageCounters.set('guild-1:channel-1', {
                count: runtimeConfig.catchUp.ifMentionedAfterMessages - 1,
                lastUpdated: Date.now(),
            });
            eventAccess.catchupFilter.shouldSkipPlanner = async () => ({
                skip: false,
                reason: 'allow',
            });
            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply,
                trigger
            ) => {
                processCalls.push({ directReply, trigger });
            };

            await event.execute(createMessage('hey ari can you explain this?'));

            assert.equal(processCalls.length, 1);
            assert.equal(processCalls[0]?.directReply, false);
            assert.match(processCalls[0]?.trigger ?? '', /catching up/i);
        }
    );
});

test('execute does not treat substring false positives as plaintext mention aliases', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as {
                realtimeFilter: unknown;
                contextManager: unknown;
                channelMessageCounters: Map<
                    string,
                    { count: number; lastUpdated: number }
                >;
                messageProcessor: {
                    processMessage: (
                        message: unknown,
                        directReply: boolean,
                        trigger: string
                    ) => Promise<void>;
                };
            };
            let processCalls = 0;

            eventAccess.realtimeFilter = null;
            eventAccess.contextManager = null;
            eventAccess.channelMessageCounters.set('guild-1:channel-1', {
                count: runtimeConfig.catchUp.ifMentionedAfterMessages - 1,
                lastUpdated: Date.now(),
            });
            eventAccess.messageProcessor.processMessage = async () => {
                processCalls += 1;
            };

            await event.execute(createMessage('variable naming discussion'));

            assert.equal(processCalls, 0);
        }
    );
});

test('execute still responds immediately to direct mentions and replies', async () => {
    await withProfile(createProfile(), async () => {
        const mentionEvent = createEvent();
        const mentionAccess = mentionEvent as unknown as {
            contextManager: unknown;
            messageProcessor: {
                processMessage: (
                    message: unknown,
                    directReply: boolean,
                    trigger: string
                ) => Promise<void>;
            };
        };
        const replyEvent = createEvent();
        const replyAccess = replyEvent as unknown as {
            contextManager: unknown;
            messageProcessor: {
                processMessage: (
                    message: unknown,
                    directReply: boolean,
                    trigger: string
                ) => Promise<void>;
            };
        };
        const mentionCalls: string[] = [];
        const replyCalls: string[] = [];

        mentionAccess.contextManager = null;
        replyAccess.contextManager = null;
        mentionAccess.messageProcessor.processMessage = async (
            _message,
            directReply,
            trigger
        ) => {
            assert.equal(directReply, true);
            mentionCalls.push(trigger);
        };
        replyAccess.messageProcessor.processMessage = async (
            _message,
            directReply,
            trigger
        ) => {
            assert.equal(directReply, true);
            replyCalls.push(trigger);
        };

        await mentionEvent.execute(
            createMessage('hello', {
                mentions: {
                    users: {
                        has: () => true,
                    },
                    repliedUser: null,
                },
            })
        );
        await replyEvent.execute(
            createMessage('replying now', {
                reference: {
                    messageId: 'prior-message',
                    guildId: 'guild-1',
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
        );

        assert.equal(mentionCalls.length, 1);
        assert.match(mentionCalls[0] ?? '', /direct ping/i);
        assert.equal(replyCalls.length, 1);
        assert.match(replyCalls[0] ?? '', /direct reply/i);
    });
});
