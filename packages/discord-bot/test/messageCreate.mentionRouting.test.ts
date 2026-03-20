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
import type {
    ChannelMetrics,
    StoredMessage,
} from '../src/state/ChannelContextManager.js';
import type { EngagementDecision } from '../src/engagement/RealtimeEngagementFilter.js';

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

const createEvent = () =>
    new MessageCreate({
        openaiService: {
            async generateSpeech() {
                return 'tts.mp3';
            },
        } as never,
    });

type MutableBotDirectInvocationConfig = {
    minEngageThreshold: number;
};

type MentionRoutingEventAccess = {
    realtimeFilter: unknown;
    contextManager: {
        recordMessage: (channelId: string, message: unknown) => void;
        getRecentMessages: (
            channelId: string,
            count?: number
        ) => StoredMessage[];
        getMetrics: (channelId: string) => ChannelMetrics | null;
    } | null;
    botDirectInvocationFilter: {
        decide: (
            context: unknown,
            overrides?: unknown
        ) => Promise<EngagementDecision>;
    };
    channelMessageCounters: Map<string, { count: number; lastUpdated: number }>;
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

const withBotDirectInvocationConfig = async (
    overrides: Partial<MutableBotDirectInvocationConfig>,
    fn: () => Promise<void> | void
): Promise<void> => {
    const mutableRuntimeConfig = runtimeConfig as unknown as {
        botDirectInvocation: MutableBotDirectInvocationConfig;
    };
    const previousConfig = { ...mutableRuntimeConfig.botDirectInvocation };
    mutableRuntimeConfig.botDirectInvocation = {
        ...mutableRuntimeConfig.botDirectInvocation,
        ...overrides,
    };

    try {
        await fn();
    } finally {
        mutableRuntimeConfig.botDirectInvocation = previousConfig;
    }
};

let messageSequence = 0;

const createMessage = (
    content: string,
    overrides: Record<string, unknown> = {}
) =>
    ({
        id: `message-${++messageSequence}`,
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
        attachments: {
            size: 0,
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

const createBotAuthor = (authorId = 'bot-a') => ({
    id: authorId,
    bot: true,
    username: authorId,
});

const createStoredMessage = (
    overrides: Partial<StoredMessage> = {}
): StoredMessage => ({
    id: `stored-${++messageSequence}`,
    authorId: 'user-2',
    authorUsername: 'Taylor',
    content: 'please help explain this bug',
    timestamp: Date.now() - 1_000,
    isBot: false,
    tokenEstimate: 8,
    ...overrides,
});

const createRecentHumanMessage = (content = 'please explain this bug?') =>
    createMessage(content, {
        id: `recent-human-${++messageSequence}`,
        author: {
            id: 'user-2',
            bot: false,
            username: 'Taylor',
        },
    });

const createRecentMessageMap = (...messages: Array<{ id: string }>) =>
    new Map<string, unknown>(messages.map((message) => [message.id, message]));

test('execute treats vendored plaintext aliases as direct invocations', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            const processCalls: Array<{
                directReply: boolean;
                trigger: string;
            }> = [];
            let catchupFilterCalls = 0;

            eventAccess.realtimeFilter = null;
            eventAccess.contextManager = null;
            eventAccess.channelMessageCounters.set('guild-1:channel-1', {
                count: runtimeConfig.catchUp.ifMentionedAfterMessages - 1,
                lastUpdated: Date.now(),
            });
            eventAccess.catchupFilter.shouldSkipPlanner = async () => {
                catchupFilterCalls += 1;
                return {
                    skip: false,
                    reason: 'allow',
                };
            };
            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply,
                trigger
            ) => {
                processCalls.push({ directReply, trigger });
            };

            await event.execute(createMessage('hey ari can you explain this?'));

            assert.equal(processCalls.length, 1);
            assert.equal(processCalls[0]?.directReply, true);
            assert.match(
                processCalls[0]?.trigger ?? '',
                /Mentioned by plaintext alias: ari/
            );
            assert.equal(catchupFilterCalls, 0);
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
            const eventAccess = event as unknown as MentionRoutingEventAccess;
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
        const mentionAccess =
            mentionEvent as unknown as MentionRoutingEventAccess;
        const replyEvent = createEvent();
        const replyAccess = replyEvent as unknown as MentionRoutingEventAccess;
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

test('execute denies bot-authored plaintext aliases by default', async () => {
    await withProfile(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari'],
        }),
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            let processCalls = 0;

            eventAccess.messageProcessor.processMessage = async () => {
                processCalls += 1;
            };

            await event.execute(
                createMessage('hey ari can you explain this bug?', {
                    author: createBotAuthor('bot-alias'),
                })
            );

            assert.equal(processCalls, 0);
        }
    );
});

test('execute denies bot-authored direct mentions when recent human context is missing', async () => {
    await withBotDirectInvocationConfig(
        { minEngageThreshold: 0.75 },
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            let processCalls = 0;

            eventAccess.messageProcessor.processMessage = async () => {
                processCalls += 1;
            };
            eventAccess.botDirectInvocationFilter.decide = async () => ({
                engage: true,
                score: 0.99,
                reason: 'would otherwise allow',
                reasons: ['mention'],
                breakdown: { mention: 1 },
            });

            await event.execute(
                createMessage('hello footnote', {
                    author: createBotAuthor('bot-mention'),
                    mentions: {
                        users: {
                            has: () => true,
                        },
                        repliedUser: null,
                    },
                })
            );

            assert.equal(processCalls, 0);
        }
    );
});

test('execute denies bot-authored direct replies when recent human context is missing', async () => {
    await withBotDirectInvocationConfig(
        { minEngageThreshold: 0.75 },
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            let processCalls = 0;

            eventAccess.messageProcessor.processMessage = async () => {
                processCalls += 1;
            };
            eventAccess.botDirectInvocationFilter.decide = async () => ({
                engage: true,
                score: 0.99,
                reason: 'would otherwise allow',
                reasons: ['reply'],
                breakdown: { mention: 1 },
            });

            await event.execute(
                createMessage('replying now', {
                    author: createBotAuthor('bot-reply'),
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

            assert.equal(processCalls, 0);
        }
    );
});

test('execute allows bot-authored direct mentions when recent human context exists and the stricter score passes', async () => {
    await withBotDirectInvocationConfig(
        { minEngageThreshold: 0.75 },
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            const processCalls: string[] = [];

            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply,
                trigger
            ) => {
                assert.equal(directReply, true);
                processCalls.push(trigger);
            };
            eventAccess.botDirectInvocationFilter.decide = async () => ({
                engage: true,
                score: 0.81,
                reason: 'allow',
                reasons: ['mention', 'human_activity'],
                breakdown: { mention: 1, humanActivity: 1 },
            });

            await event.execute(
                createMessage('hello footnote', {
                    author: createBotAuthor('bot-allowed'),
                    mentions: {
                        users: {
                            has: () => true,
                        },
                        repliedUser: null,
                    },
                    channel: {
                        id: 'channel-1',
                        type: 'GUILD_TEXT',
                        isThread: () => false,
                        isTextBased: () => true,
                        messages: {
                            fetch: async () =>
                                createRecentMessageMap(
                                    createRecentHumanMessage()
                                ),
                        },
                    },
                })
            );

            assert.equal(processCalls.length, 1);
            assert.match(processCalls[0] ?? '', /direct ping/i);
        }
    );
});

test('execute allows bot-authored direct replies when recent human context exists and the stricter score passes', async () => {
    await withBotDirectInvocationConfig(
        { minEngageThreshold: 0.75 },
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            const processCalls: string[] = [];

            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply,
                trigger
            ) => {
                assert.equal(directReply, true);
                processCalls.push(trigger);
            };
            eventAccess.botDirectInvocationFilter.decide = async () => ({
                engage: true,
                score: 0.81,
                reason: 'allow',
                reasons: ['reply', 'human_activity'],
                breakdown: { mention: 1, humanActivity: 1 },
            });

            await event.execute(
                createMessage('replying now', {
                    author: createBotAuthor('bot-reply-allowed'),
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
                    channel: {
                        id: 'channel-1',
                        type: 'GUILD_TEXT',
                        isThread: () => false,
                        isTextBased: () => true,
                        messages: {
                            fetch: async () =>
                                createRecentMessageMap(
                                    createRecentHumanMessage()
                                ),
                        },
                    },
                })
            );

            assert.equal(processCalls.length, 1);
            assert.match(processCalls[0] ?? '', /direct reply/i);
        }
    );
});

test('execute falls back to retained context when recent message fetch fails', async () => {
    await withBotDirectInvocationConfig(
        { minEngageThreshold: 0.75 },
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            let processCalls = 0;
            let fallbackRecentMessages = 0;

            eventAccess.contextManager = {
                recordMessage: () => undefined,
                getRecentMessages: () => [createStoredMessage()],
                getMetrics: () => ({
                    windowTotalMessages: 2,
                    windowBotMessages: 1,
                    windowHumanMessages: 1,
                    lastEngagementScore: 0,
                    lastActivity: Date.now(),
                    flags: [],
                }),
            };
            eventAccess.messageProcessor.processMessage = async () => {
                processCalls += 1;
            };
            eventAccess.botDirectInvocationFilter.decide = async (context) => {
                const typedContext = context as {
                    recentMessages: Array<{ author: { bot: boolean } }>;
                };
                fallbackRecentMessages = typedContext.recentMessages.length;
                return {
                    engage: true,
                    score: 0.81,
                    reason: 'allow',
                    reasons: ['human_activity'],
                    breakdown: { humanActivity: 1 },
                };
            };

            await event.execute(
                createMessage('hello footnote', {
                    author: createBotAuthor('bot-fallback'),
                    mentions: {
                        users: {
                            has: () => true,
                        },
                        repliedUser: null,
                    },
                    channel: {
                        id: 'channel-1',
                        type: 'GUILD_TEXT',
                        isThread: () => false,
                        isTextBased: () => true,
                        messages: {
                            fetch: async () => {
                                throw new Error('fetch failed');
                            },
                        },
                    },
                })
            );

            assert.equal(fallbackRecentMessages, 1);
            assert.equal(processCalls, 1);
        }
    );
});

test('execute fails open for bot direct mentions when recent context cannot be fetched or recovered', async () => {
    await withBotDirectInvocationConfig(
        { minEngageThreshold: 0.75 },
        async () => {
            const event = createEvent();
            const eventAccess = event as unknown as MentionRoutingEventAccess;
            let processCalls = 0;
            let decideCalls = 0;

            eventAccess.contextManager = null;
            eventAccess.messageProcessor.processMessage = async () => {
                processCalls += 1;
            };
            eventAccess.botDirectInvocationFilter.decide = async () => {
                decideCalls += 1;
                return {
                    engage: false,
                    score: 0,
                    reason: 'should not be called',
                    reasons: [],
                    breakdown: {},
                };
            };

            await event.execute(
                createMessage('hello footnote', {
                    author: createBotAuthor('bot-fail-open'),
                    mentions: {
                        users: {
                            has: () => true,
                        },
                        repliedUser: null,
                    },
                    channel: {
                        id: 'channel-1',
                        type: 'GUILD_TEXT',
                        isThread: () => false,
                        isTextBased: () => true,
                        messages: {
                            fetch: async () => {
                                throw new Error('fetch failed');
                            },
                        },
                    },
                })
            );

            assert.equal(decideCalls, 0);
            assert.equal(processCalls, 1);
        }
    );
});

test('execute uses retained synthetic messages safely in catchup mode when fetch fails and realtime filtering is disabled', async () => {
    await withProfile(createProfile(), async () => {
        const event = createEvent();
        const eventAccess = event as unknown as MentionRoutingEventAccess;
        let processCalls = 0;

        eventAccess.realtimeFilter = null;
        eventAccess.contextManager = {
            recordMessage: () => undefined,
            getRecentMessages: () => [
                createStoredMessage({
                    content: '',
                    timestamp: Date.now() - 3_000,
                }),
                createStoredMessage({
                    content: '',
                    timestamp: Date.now() - 2_000,
                }),
                createStoredMessage({
                    content: '',
                    timestamp: Date.now() - 1_000,
                }),
            ],
            getMetrics: () => null,
        };
        eventAccess.channelMessageCounters.set('DM:channel-1', {
            count: runtimeConfig.catchUp.afterMessages - 1,
            lastUpdated: Date.now(),
        });
        eventAccess.messageProcessor.processMessage = async () => {
            processCalls += 1;
        };

        await event.execute(
            createMessage('', {
                guildId: null,
                channelId: 'channel-1',
                channel: {
                    id: 'channel-1',
                    type: 'DM',
                    isThread: () => false,
                    isTextBased: () => true,
                    messages: {
                        fetch: async () => {
                            throw new Error('fetch failed');
                        },
                    },
                },
            })
        );

        assert.equal(processCalls, 0);
    });
});
