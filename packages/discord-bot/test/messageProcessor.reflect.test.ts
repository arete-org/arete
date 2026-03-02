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
import { botApi } from '../src/api/botApi.js';
import { logger } from '../src/utils/logger.js';
import { MessageProcessor } from '../src/utils/MessageProcessor.js';

const createMetadata = (): ResponseMetadata => ({
    responseId: 'resp_123',
    provenance: 'Inferred',
    confidence: 0.75,
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

test('executeReflectMessageAction sends text, builds a footer follow-up, and skips trace posting', async () => {
    const processor = createProcessor();
    const message = createMessage();
    const sentMessages: Array<{
        content: string;
        directReply: boolean;
        suppressEmbeds: boolean;
    }> = [];
    let footerPayloadSeen = false;
    const originalPostTraces = botApi.postTraces;

    (botApi as { postTraces: unknown }).postTraces = async () => {
        throw new Error('postTraces should not run for backend reflect messages');
    };
    (processor as { sendProvenanceFooter: unknown }).sendProvenanceFooter =
        async (
            _footerReplyAnchor: unknown,
            _originalMessage: unknown,
            footerPayload: unknown
        ) => {
            footerPayloadSeen = Boolean(footerPayload);
        };

    try {
        await (
            processor as {
                executeReflectMessageAction: (
                    message: unknown,
                    responseHandler: unknown,
                    reflectResponse: unknown,
                    directReply: boolean
                ) => Promise<void>;
            }
        ).executeReflectMessageAction(
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
    assert.equal(footerPayloadSeen, true);
});

test('executeReflectAction routes react actions without falling back to message generation', async () => {
    const processor = createProcessor();
    let reactedWith = '';
    let messageActionCalls = 0;

    (processor as { executeReflectMessageAction: unknown }).executeReflectMessageAction =
        async () => {
            messageActionCalls += 1;
        };

    await (
        processor as {
            executeReflectAction: (
                message: unknown,
                responseHandler: unknown,
                reflectResponse: unknown,
                directReply: boolean,
                recoveredImageContext: unknown
            ) => Promise<void>;
        }
    ).executeReflectAction(
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
    let imagePrompt = '';

    (processor as { executeReflectImageAction: unknown }).executeReflectImageAction =
        async (
            _message: unknown,
            _responseHandler: unknown,
            imageRequest: { prompt: string }
        ) => {
            imagePrompt = imageRequest.prompt;
        };

    await (
        processor as {
            executeReflectAction: (
                message: unknown,
                responseHandler: unknown,
                reflectResponse: unknown,
                directReply: boolean,
                recoveredImageContext: unknown
            ) => Promise<void>;
        }
    ).executeReflectAction(
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
    const originalWarn = logger.warn;
    const warnings: string[] = [];

    logger.warn = ((message: string) => {
        warnings.push(message);
    }) as typeof logger.warn;

    try {
        await (
            processor as {
                executeReflectAction: (
                    message: unknown,
                    responseHandler: unknown,
                    reflectResponse: unknown,
                    directReply: boolean,
                    recoveredImageContext: unknown
                ) => Promise<void>;
            }
        ).executeReflectAction(
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
