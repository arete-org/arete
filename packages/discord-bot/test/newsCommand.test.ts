/**
 * @description: Verifies the `/news` command uses the backend-owned news task path and renders the returned results safely.
 * @footnote-scope: test
 * @footnote-module: NewsCommandTests
 * @footnote-risk: medium - Missing tests here could let the command drift away from the backend-owned task path or break reply rendering.
 * @footnote-ethics: medium - Confirms the bot presents backend-owned news summaries consistently and falls back cleanly on errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { botApi } from '../src/api/botApi.js';
import newsCommand from '../src/commands/news.js';

test('news command calls the backend-owned news task and renders the returned summary', async () => {
    const originalRunNewsTaskViaApi = botApi.runNewsTaskViaApi;
    const deferReplyPayloads: unknown[] = [];
    const editReplyPayloads: unknown[] = [];
    const seenRequests: unknown[] = [];
    let seenSignal: AbortSignal | undefined;

    botApi.runNewsTaskViaApi = (async (request, options) => {
        seenRequests.push(request);
        seenSignal = options?.signal;
        return {
            task: 'news',
            result: {
                news: [
                    {
                        title: 'Policy update',
                        summary: 'A concise summary',
                        url: 'https://example.com/news',
                        source: 'Example News',
                        timestamp: '2026-03-18T12:00:00.000Z',
                    },
                ],
                summary: 'One important headline today.',
            },
        };
    }) as typeof botApi.runNewsTaskViaApi;

    try {
        await newsCommand.execute({
            id: 'interaction-1',
            commandName: 'news',
            channelId: 'channel-123',
            guildId: 'guild-456',
            token: 'token-present',
            user: { tag: 'tester#0001' },
            channel: { id: 'channel-123' },
            isChatInputCommand: () => true,
            options: {
                data: [
                    { name: 'query', value: 'latest ai policy' },
                    { name: 'max_results', value: 2 },
                ],
                getString: (name: string) => {
                    if (name === 'query') {
                        return 'latest ai policy';
                    }
                    return null;
                },
                getInteger: (name: string) =>
                    name === 'max_results' ? 2 : null,
            },
            deferReply: async (payload?: unknown) => {
                deferReplyPayloads.push(payload);
            },
            editReply: async (payload: unknown) => {
                editReplyPayloads.push(payload);
            },
        } as never);

        assert.equal(deferReplyPayloads.length, 1);
        assert.deepEqual(seenRequests, [
            {
                task: 'news',
                query: 'latest ai policy',
                category: undefined,
                maxResults: 2,
                reasoningEffort: 'medium',
                verbosity: 'medium',
                channelContext: {
                    channelId: 'channel-123',
                    guildId: 'guild-456',
                },
            },
        ]);
        assert.ok(seenSignal);
        assert.equal(seenSignal.aborted, false);

        const reply = editReplyPayloads[0] as {
            content?: string;
            embeds?: Array<{
                data?: {
                    title?: string;
                    description?: string;
                    footer?: { text?: string };
                };
            }>;
        };
        assert.match(String(reply.content), /\*\*News\*\* for query: "latest ai policy"/i);
        assert.match(String(reply.content), /One important headline today\./);
        assert.equal(reply.embeds?.length, 1);
        assert.equal(reply.embeds?.[0]?.data?.title, 'Policy update');
        assert.equal(
            reply.embeds?.[0]?.data?.description,
            'A concise summary'
        );
        assert.match(
            String(reply.embeds?.[0]?.data?.footer?.text),
            /Source: Example News •/
        );
    } finally {
        botApi.runNewsTaskViaApi = originalRunNewsTaskViaApi;
    }
});

test('news command omits publish time when the backend does not provide one', async () => {
    const originalRunNewsTaskViaApi = botApi.runNewsTaskViaApi;
    const editReplyPayloads: unknown[] = [];

    botApi.runNewsTaskViaApi = (async () => {
        return {
            task: 'news',
            result: {
                news: [
                    {
                        title: 'Date-only article',
                        summary: 'The backend kept the article but stripped the fake time.',
                        url: 'https://example.com/news',
                        source: 'Example News',
                    },
                ],
                summary: 'One headline without a confirmed publish time.',
            },
        };
    }) as typeof botApi.runNewsTaskViaApi;

    try {
        await newsCommand.execute({
            id: 'interaction-optional-time',
            commandName: 'news',
            channelId: 'channel-123',
            guildId: 'guild-456',
            token: 'token-present',
            user: { tag: 'tester#0001' },
            channel: { id: 'channel-123' },
            isChatInputCommand: () => true,
            options: {
                data: [],
                getString: () => null,
                getInteger: () => null,
            },
            deferReply: async () => undefined,
            editReply: async (payload: unknown) => {
                editReplyPayloads.push(payload);
            },
        } as never);

        const reply = editReplyPayloads[0] as {
            embeds?: Array<{ data?: { footer?: { text?: string } } }>;
        };
        assert.equal(
            reply.embeds?.[0]?.data?.footer?.text,
            'Source: Example News'
        );
    } finally {
        botApi.runNewsTaskViaApi = originalRunNewsTaskViaApi;
    }
});

test('news command edits the deferred reply with a generic error message when the backend task fails', async () => {
    const originalRunNewsTaskViaApi = botApi.runNewsTaskViaApi;
    const editReplyPayloads: unknown[] = [];

    botApi.runNewsTaskViaApi = (async () => {
        throw new Error('backend exploded');
    }) as typeof botApi.runNewsTaskViaApi;

    try {
        await newsCommand.execute({
            id: 'interaction-2',
            commandName: 'news',
            channelId: 'channel-123',
            guildId: 'guild-456',
            token: 'token-present',
            user: { tag: 'tester#0001' },
            channel: { id: 'channel-123' },
            isChatInputCommand: () => true,
            options: {
                data: [],
                getString: () => null,
                getInteger: () => null,
            },
            deferReply: async () => undefined,
            editReply: async (payload: unknown) => {
                editReplyPayloads.push(payload);
            },
        } as never);

        assert.equal(editReplyPayloads.length, 1);
        assert.match(
            String(editReplyPayloads[0]),
            /An error occurred while fetching news/i
        );
    } finally {
        botApi.runNewsTaskViaApi = originalRunNewsTaskViaApi;
    }
});
