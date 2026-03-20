/**
 * @description: Verifies MessageCreate applies bot-loop limits across an entire channel streak instead of per external bot.
 * @footnote-scope: test
 * @footnote-module: MessageCreateBotLoopGuardTests
 * @footnote-risk: high - Regressions here can allow runaway bot-to-bot loops or suppress legitimate recovery after cooldown.
 * @footnote-ethics: high - Bot-loop guard behavior determines whether Footnote spams shared spaces or backs off respectfully.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeConfig } from '../src/config.js';
import { MessageCreate } from '../src/events/MessageCreate.js';
import type { EngagementDecision } from '../src/engagement/RealtimeEngagementFilter.js';

type MutableBotInteractionConfig = {
    maxBackAndForth: number;
    cooldownMs: number;
    afterLimitAction: 'react' | 'ignore';
    reactionEmoji: string;
};

const withBotInteractionConfig = async (
    overrides: Partial<MutableBotInteractionConfig>,
    fn: () => Promise<void> | void
): Promise<void> => {
    const mutableRuntimeConfig = runtimeConfig as unknown as {
        botInteraction: MutableBotInteractionConfig;
    };
    const previousConfig = { ...mutableRuntimeConfig.botInteraction };
    mutableRuntimeConfig.botInteraction = {
        ...mutableRuntimeConfig.botInteraction,
        ...overrides,
    };

    try {
        await fn();
    } finally {
        mutableRuntimeConfig.botInteraction = previousConfig;
    }
};

const withMockedDateNow = async (
    startingNow: number,
    fn: (clock: {
        now: () => number;
        advanceBy: (ms: number) => void;
    }) => Promise<void> | void
): Promise<void> => {
    const originalDateNow = Date.now;
    let currentNow = startingNow;
    Date.now = () => currentNow;

    try {
        await fn({
            now: () => currentNow,
            advanceBy: (ms: number) => {
                currentNow += ms;
            },
        });
    } finally {
        Date.now = originalDateNow;
    }
};

const createEvent = () =>
    new MessageCreate({
        openaiService: {
            async generateSpeech() {
                return 'tts.mp3';
            },
        } as never,
    });

type BotLoopGuardEventAccess = {
    realtimeFilter: unknown;
    contextManager: unknown;
    botDirectInvocationFilter: {
        decide: (
            context: unknown,
            overrides?: unknown
        ) => Promise<EngagementDecision>;
    };
    messageProcessor: {
        processMessage: (
            message: unknown,
            directReply: boolean,
            trigger: string
        ) => Promise<void>;
    };
};

const allowBotDirectInvocations = (
    event: MessageCreate
): BotLoopGuardEventAccess => {
    const eventAccess = event as unknown as BotLoopGuardEventAccess;
    eventAccess.realtimeFilter = null;
    eventAccess.contextManager = null;
    eventAccess.botDirectInvocationFilter.decide = async () => ({
        engage: true,
        score: 0.81,
        reason: 'allow',
        reasons: ['mention', 'human_activity'],
        breakdown: { mention: 1, humanActivity: 1 },
    });
    return eventAccess;
};

let messageSequence = 0;

const createRecentHumanMessage = (content = 'please help explain this bug?') =>
    ({
        id: `recent-human-${++messageSequence}`,
        content,
        guildId: 'guild-1',
        channelId: 'channel-1',
        createdTimestamp: Date.now() - 1_000,
        author: {
            id: 'user-2',
            bot: false,
            username: 'Taylor',
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
    }) as never;

const createRecentMessageMap = (...messages: Array<{ id: string }>) =>
    new Map<string, unknown>(messages.map((message) => [message.id, message]));

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
                fetch: async () =>
                    createRecentMessageMap(createRecentHumanMessage()),
            },
        },
        reply: async () => undefined,
        ...overrides,
    }) as never;

const createBotMentionMessage = (authorId: string, content = 'hello') =>
    createMessage(content, {
        author: {
            id: authorId,
            bot: true,
            username: authorId,
        },
        mentions: {
            users: {
                has: () => true,
            },
            repliedUser: null,
        },
    });

const createBotReplyMessage = (authorId: string, content = 'replying now') =>
    createMessage(content, {
        author: {
            id: authorId,
            bot: true,
            username: authorId,
        },
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
    });

const createSelfMessage = (content = 'Footnote reply') =>
    createMessage(content, {
        author: {
            id: 'bot-1',
            bot: true,
            username: 'FootnoteBot',
        },
    });

test('execute allows bot direct replies until the shared bot-only streak limit is reached', async () => {
    await withBotInteractionConfig(
        {
            maxBackAndForth: 2,
            cooldownMs: 5_000,
            afterLimitAction: 'ignore',
        },
        async () => {
            const event = createEvent();
            const eventAccess = allowBotDirectInvocations(event);
            const processCalls: string[] = [];
            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply,
                trigger
            ) => {
                assert.equal(directReply, true);
                processCalls.push(trigger);
            };

            await event.execute(createBotReplyMessage('bot-a'));
            await event.execute(createSelfMessage());
            await event.execute(createBotReplyMessage('bot-b'));
            await event.execute(createSelfMessage());
            await event.execute(createBotReplyMessage('bot-c'));

            assert.equal(processCalls.length, 2);
            assert.match(processCalls[0] ?? '', /direct reply/i);
            assert.match(processCalls[1] ?? '', /direct reply/i);
        }
    );
});

test('execute does not reset the limit when different bot IDs alternate in one streak', async () => {
    await withBotInteractionConfig(
        {
            maxBackAndForth: 2,
            cooldownMs: 5_000,
            afterLimitAction: 'ignore',
        },
        async () => {
            const event = createEvent();
            const eventAccess = allowBotDirectInvocations(event);
            let processCalls = 0;
            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply
            ) => {
                assert.equal(directReply, true);
                processCalls += 1;
            };

            await event.execute(createBotMentionMessage('bot-a'));
            await event.execute(createSelfMessage());
            await event.execute(createBotMentionMessage('bot-b'));
            await event.execute(createSelfMessage());
            await event.execute(createBotMentionMessage('bot-c'));

            assert.equal(processCalls, 2);
        }
    );
});

test('execute resets the bot-only streak as soon as a human message arrives', async () => {
    await withBotInteractionConfig(
        {
            maxBackAndForth: 2,
            cooldownMs: 5_000,
            afterLimitAction: 'ignore',
        },
        async () => {
            const event = createEvent();
            const eventAccess = allowBotDirectInvocations(event);
            let processCalls = 0;
            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply
            ) => {
                assert.equal(directReply, true);
                processCalls += 1;
            };

            await event.execute(createBotMentionMessage('bot-a'));
            await event.execute(createSelfMessage());
            await event.execute(createBotMentionMessage('bot-b'));
            await event.execute(createSelfMessage());
            await event.execute(createMessage('human interruption'));
            await event.execute(createBotMentionMessage('bot-c'));

            assert.equal(processCalls, 3);
        }
    );
});

test('execute allows a fresh bot-only streak after cooldown expires', async () => {
    await withBotInteractionConfig(
        {
            maxBackAndForth: 1,
            cooldownMs: 1_000,
            afterLimitAction: 'ignore',
        },
        async () => {
            await withMockedDateNow(1_000, async (clock) => {
                const event = createEvent();
                const eventAccess = allowBotDirectInvocations(event);
                let processCalls = 0;
                eventAccess.messageProcessor.processMessage = async (
                    _message,
                    directReply
                ) => {
                    assert.equal(directReply, true);
                    processCalls += 1;
                };

                await event.execute(createBotMentionMessage('bot-a'));
                await event.execute(createSelfMessage());
                await event.execute(createBotMentionMessage('bot-b'));

                assert.equal(processCalls, 1);

                clock.advanceBy(1_100);

                await event.execute(createBotMentionMessage('bot-c'));

                assert.equal(processCalls, 2);
            });
        }
    );
});

test('execute requires a bot-authored direct mention to pass both the admission gate and the loop guard', async () => {
    await withBotInteractionConfig(
        {
            maxBackAndForth: 1,
            cooldownMs: 5_000,
            afterLimitAction: 'ignore',
        },
        async () => {
            const event = createEvent();
            const eventAccess = allowBotDirectInvocations(event);
            let processCalls = 0;
            eventAccess.messageProcessor.processMessage = async (
                _message,
                directReply
            ) => {
                assert.equal(directReply, true);
                processCalls += 1;
            };

            await event.execute(createBotMentionMessage('bot-a'));
            await event.execute(createSelfMessage());
            await event.execute(createBotMentionMessage('bot-b'));

            assert.equal(processCalls, 1);
        }
    );
});
