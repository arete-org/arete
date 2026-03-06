/**
 * @description: Covers backend-driven reflect action execution in the Discord message processor.
 * @footnote-scope: test
 * @footnote-module: MessageProcessorReflectTests
 * @footnote-risk: medium - Missing tests could let backend action routing regress silently in the bot.
 * @footnote-ethics: medium - These checks protect provenance rendering and safe fallback behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type {
    PostReflectRequest,
    PostTraceCardRequest,
} from '@footnote/contracts/web';
import { botApi } from '../src/api/botApi.js';
import { logger } from '../src/utils/logger.js';
import { MessageProcessor } from '../src/utils/MessageProcessor.js';
import { ResponseHandler } from '../src/utils/response/ResponseHandler.js';

const createMetadata = (): ResponseMetadata => ({
    responseId: 'resp_123',
    provenance: 'Inferred',
    riskTier: 'Low',
    tradeoffCount: 1,
    chainHash: 'hash_123',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
});

const createProcessor = () =>
    new MessageProcessor({
        openaiService: {
            async generateSpeech() {
                return 'tts.mp3';
            },
        } as never,
    });

const createMessage = () =>
    ({
        id: 'message-1',
        content: 'What changed in the repo?',
        author: {
            id: 'user-1',
            username: 'Jordan',
        },
        channel: {
            id: 'channel-1',
        },
    }) as never;

type ProcessorPrivateAccess = {
    sendProvenanceCgi: (
        provenanceReplyAnchor: unknown,
        originalMessage: unknown,
        metadata: ResponseMetadata
    ) => Promise<void>;
    executeReflectMessageAction: (
        message: unknown,
        responseHandler: unknown,
        reflectResponse: unknown,
        directReply: boolean
    ) => Promise<void>;
    executeReflectAction: (
        message: unknown,
        responseHandler: unknown,
        reflectResponse: unknown,
        directReply: boolean,
        recoveredImageContext: unknown
    ) => Promise<void>;
    executeReflectImageAction: (
        message: unknown,
        responseHandler: unknown,
        imageRequest: { prompt: string },
        directReply: boolean,
        recoveredImageContext: unknown
    ) => Promise<void>;
    checkRateLimits: (message: unknown) => Promise<{
        allowed: boolean;
        error?: string;
    }>;
    buildReflectRequestFromMessage: (
        message: unknown,
        trigger: string
    ) => Promise<{
        request: PostReflectRequest;
        recoveredImageContext: null;
    } | null>;
};

test('executeReflectMessageAction sends text, triggers CGI follow-up, and skips trace posting', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    const message = createMessage();
    const sentMessages: Array<{
        content: string;
        directReply: boolean;
        suppressEmbeds: boolean;
    }> = [];
    const capture = {
        metadataSeen: null as ResponseMetadata | null,
    };
    const originalPostTraces = botApi.postTraces;

    (botApi as { postTraces: unknown }).postTraces = async () => {
        throw new Error(
            'postTraces should not run for backend reflect messages'
        );
    };
    processorAccess.sendProvenanceCgi = async (
        _provenanceReplyAnchor: unknown,
        _originalMessage: unknown,
        metadata: ResponseMetadata
    ) => {
        capture.metadataSeen = metadata;
    };

    try {
        await processorAccess.executeReflectMessageAction(
            message,
            {
                async sendMessage(
                    content: string,
                    _files: unknown[],
                    directReply: boolean,
                    suppressEmbeds: boolean = true
                ) {
                    sentMessages.push({
                        content,
                        directReply,
                        suppressEmbeds,
                    });
                    return {
                        channel: { id: 'channel-1' },
                    };
                },
            },
            {
                action: 'message',
                message: 'Backend reflection',
                modality: 'text',
                metadata: createMetadata(),
            },
            true
        );
    } finally {
        (botApi as { postTraces: unknown }).postTraces = originalPostTraces;
    }

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].content, 'Backend reflection');
    assert.equal(sentMessages[0].directReply, true);
    if (!capture.metadataSeen) {
        throw new Error('Expected metadata to be forwarded to sendProvenanceCgi');
    }
    assert.equal(capture.metadataSeen.responseId, 'resp_123');
});

test('sendProvenanceCgi posts trace-card and sends image plus response-bound buttons', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    const originalPostTraceCard = botApi.postTraceCard;
    const originalSendMessage = ResponseHandler.prototype.sendMessage;
    const sentCalls: Array<{
        content: string;
        files: Array<{ filename: string; data: string | Buffer }>;
        directReply: boolean;
        suppressEmbeds: boolean;
        components: unknown[];
    }> = [];
    const capture = {
        traceCardRequest: null as PostTraceCardRequest | null,
    };

    (botApi as { postTraceCard: typeof botApi.postTraceCard }).postTraceCard =
        (async (request) => {
            capture.traceCardRequest = request;
            return {
                responseId: request.responseId ?? 'resp_123',
                pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
            };
        }) as typeof botApi.postTraceCard;

    ResponseHandler.prototype.sendMessage = (async (
        content: string,
        files: Array<{ filename: string; data: string | Buffer }> = [],
        directReply: boolean = false,
        suppressEmbeds: boolean = true,
        components: unknown[] = []
    ) => {
        sentCalls.push({
            content,
            files,
            directReply,
            suppressEmbeds,
            components,
        });
        return { id: 'sent-1' } as never;
    }) as typeof ResponseHandler.prototype.sendMessage;

    try {
        await processorAccess.sendProvenanceCgi(
            {
                id: 'anchor-1',
                channel: { id: 'channel-1' },
            },
            {
                id: 'message-1',
                author: { id: 'user-1', username: 'Jordan' },
            },
            {
                ...createMetadata(),
                temperament: {
                    tightness: 5,
                    rationale: 3,
                },
                evidenceScore: 4,
                freshnessScore: 5,
            }
        );
    } finally {
        (
            botApi as { postTraceCard: typeof botApi.postTraceCard }
        ).postTraceCard = originalPostTraceCard;
        ResponseHandler.prototype.sendMessage = originalSendMessage;
    }

    if (!capture.traceCardRequest) {
        throw new Error('Expected trace-card request to be captured');
    }
    const traceCardRequest = capture.traceCardRequest;
    assert.equal(traceCardRequest.responseId, 'resp_123');
    assert.deepEqual(traceCardRequest.temperament, {
        tightness: 5,
        rationale: 3,
    });
    assert.deepEqual(traceCardRequest.chips, {
        evidenceScore: 4,
        freshnessScore: 5,
    });
    assert.equal(sentCalls.length, 1);
    assert.equal(sentCalls[0].files.length, 1);
    assert.equal(sentCalls[0].files[0].filename, 'trace-card.png');
    const actionRow = sentCalls[0].components[0] as {
        toJSON: () => { components: Array<{ custom_id?: string }> };
    };
    const customIds = actionRow
        .toJSON()
        .components.map((component) => component.custom_id)
        .filter((value): value is string => typeof value === 'string');
    assert.deepEqual(customIds, ['details:resp_123', 'report_issue:resp_123']);
});

test('sendProvenanceCgi falls back to buttons-only when trace-card generation fails', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    const originalPostTraceCard = botApi.postTraceCard;
    const originalSendMessage = ResponseHandler.prototype.sendMessage;
    const sentCalls: Array<{
        files: Array<{ filename: string; data: string | Buffer }>;
        components: unknown[];
    }> = [];

    (botApi as { postTraceCard: typeof botApi.postTraceCard }).postTraceCard =
        (async () => {
            throw new Error('trace-card generation failed');
        }) as typeof botApi.postTraceCard;

    ResponseHandler.prototype.sendMessage = (async (
        _content: string,
        files: Array<{ filename: string; data: string | Buffer }> = [],
        _directReply: boolean = false,
        _suppressEmbeds: boolean = true,
        components: unknown[] = []
    ) => {
        sentCalls.push({
            files,
            components,
        });
        return { id: 'sent-2' } as never;
    }) as typeof ResponseHandler.prototype.sendMessage;

    try {
        await processorAccess.sendProvenanceCgi(
            {
                id: 'anchor-2',
                channel: { id: 'channel-2' },
            },
            {
                id: 'message-2',
                author: { id: 'user-2', username: 'Taylor' },
            },
            createMetadata()
        );
    } finally {
        (
            botApi as { postTraceCard: typeof botApi.postTraceCard }
        ).postTraceCard = originalPostTraceCard;
        ResponseHandler.prototype.sendMessage = originalSendMessage;
    }

    assert.equal(sentCalls.length, 1);
    assert.equal(sentCalls[0].files.length, 0);
    const actionRow = sentCalls[0].components[0] as {
        toJSON: () => { components: Array<{ custom_id?: string }> };
    };
    const customIds = actionRow
        .toJSON()
        .components.map((component) => component.custom_id)
        .filter((value): value is string => typeof value === 'string');
    assert.deepEqual(customIds, ['details:resp_123', 'report_issue:resp_123']);
});

test('executeReflectAction routes react actions without falling back to message generation', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    let reactedWith = '';
    let messageActionCalls = 0;

    processorAccess.executeReflectMessageAction = async () => {
        messageActionCalls += 1;
    };

    await processorAccess.executeReflectAction(
        createMessage(),
        {
            async addReaction(reaction: string) {
                reactedWith = reaction;
            },
        },
        {
            action: 'react',
            reaction: '👍',
            metadata: null,
        },
        true,
        null
    );

    assert.equal(reactedWith, '👍');
    assert.equal(messageActionCalls, 0);
});

test('executeReflectAction routes image actions into the local image pipeline helper', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    let imagePrompt = '';

    processorAccess.executeReflectImageAction = async (
        _message: unknown,
        _responseHandler: unknown,
        imageRequest: { prompt: string }
    ) => {
        imagePrompt = imageRequest.prompt;
    };

    await processorAccess.executeReflectAction(
        createMessage(),
        {},
        {
            action: 'image',
            imageRequest: {
                prompt: 'draw a reflective skyline',
            },
            metadata: null,
        },
        true,
        null
    );

    assert.equal(imagePrompt, 'draw a reflective skyline');
});

test('executeReflectAction warns and no-ops for unknown actions', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    const originalWarn = logger.warn;
    const warnings: string[] = [];

    logger.warn = ((message: string) => {
        warnings.push(message);
    }) as typeof logger.warn;

    try {
        await processorAccess.executeReflectAction(
            createMessage(),
            {},
            {
                action: 'video',
            },
            true,
            null
        );
    } finally {
        logger.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unsupported action "video"/i);
});

test('executeReflectMessageAction reports empty backend message payload as an error block', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    const sentMessages: string[] = [];
    let provenanceCalls = 0;

    processorAccess.sendProvenanceCgi = async () => {
        provenanceCalls += 1;
    };

    await processorAccess.executeReflectMessageAction(
        createMessage(),
        {
            async sendMessage(content: string) {
                sentMessages.push(content);
                return { id: 'sent-empty-error' } as never;
            },
        },
        {
            action: 'message',
            message: '   ',
            modality: 'text',
            metadata: createMetadata(),
        },
        true
    );

    assert.equal(provenanceCalls, 0);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /^```ansi\n/);
    assert.equal(
        sentMessages[0].includes('\u001b[31mReflect request failed:'),
        true
    );
    assert.match(sentMessages[0], /empty message payload/i);
});

test('processMessage replies with a red code-block error when backend reflect request fails', async () => {
    const processor = createProcessor();
    const processorAccess = processor as unknown as ProcessorPrivateAccess;
    const originalReflectViaApi = botApi.reflectViaApi;
    const originalSendMessage = ResponseHandler.prototype.sendMessage;
    const originalStartTyping = ResponseHandler.prototype.startTyping;
    const originalStopTyping = ResponseHandler.prototype.stopTyping;
    const sentMessages: string[] = [];
    let executeReflectActionCalls = 0;

    processorAccess.checkRateLimits = async () => ({ allowed: true });
    processorAccess.buildReflectRequestFromMessage = async () => ({
        request: {
            surface: 'discord',
            trigger: {
                kind: 'direct',
                messageId: 'message-1',
            },
            latestUserInput: 'Can you summarize this?',
            conversation: [
                { role: 'user', content: 'Can you summarize this?' },
            ],
            capabilities: {
                canReact: true,
                canGenerateImages: true,
                canUseTts: true,
            },
        },
        recoveredImageContext: null,
    });
    processorAccess.executeReflectAction = async () => {
        executeReflectActionCalls += 1;
    };

    (botApi as { reflectViaApi: typeof botApi.reflectViaApi }).reflectViaApi =
        (async () => {
            const timeoutError = new Error(
                'Request timed out after 180000ms'
            ) as Error & {
                name: string;
                code: string;
                endpoint: string;
                status: null;
            };
            timeoutError.name = 'DiscordApiClientError';
            timeoutError.code = 'timeout_error';
            timeoutError.endpoint = '/api/reflect';
            timeoutError.status = null;
            throw timeoutError;
        }) as typeof botApi.reflectViaApi;

    ResponseHandler.prototype.sendMessage = (async (content: string) => {
        sentMessages.push(content);
        return { id: 'sent-error' } as never;
    }) as typeof ResponseHandler.prototype.sendMessage;
    ResponseHandler.prototype.startTyping = (async () => {
        return;
    }) as typeof ResponseHandler.prototype.startTyping;
    ResponseHandler.prototype.stopTyping = (() => {
        return;
    }) as typeof ResponseHandler.prototype.stopTyping;

    const message = {
        id: 'message-1',
        content: 'Can you summarize this?',
        author: { id: 'user-1', username: 'Jordan' },
        channel: { id: 'channel-1' },
        attachments: {
            some: () => false,
            filter: () => ({ size: 0 }),
        },
        embeds: [],
        channelId: 'channel-1',
        guildId: 'guild-1',
    } as never;

    try {
        await processor.processMessage(message, true, 'direct');
    } finally {
        (
            botApi as { reflectViaApi: typeof botApi.reflectViaApi }
        ).reflectViaApi = originalReflectViaApi;
        ResponseHandler.prototype.sendMessage = originalSendMessage;
        ResponseHandler.prototype.startTyping = originalStartTyping;
        ResponseHandler.prototype.stopTyping = originalStopTyping;
    }

    assert.equal(executeReflectActionCalls, 0);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /^```ansi\n/);
    assert.equal(
        sentMessages[0].includes('\u001b[31mReflect request failed:'),
        true
    );
    assert.match(
        sentMessages[0],
        /Timed out while waiting for backend reflect response/i
    );
});
