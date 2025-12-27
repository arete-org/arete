/**
 * @arete-module: LoggingPrivacyTests
 * @arete-risk: low
 * @arete-ethics: high
 * @arete-scope: test
 *
 * @description: Validates that logging utilities redact or avoid leaking sensitive Discord
 * data, and that verbose logging is gated behind explicit flags.
 *
 * @impact
 * Risk: Logging regressions can leak sensitive data.
 * Ethics: Protects user privacy by preventing raw identifiers in logs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { transports } from 'winston';

import { OpenAIService, type OpenAIMessage } from '../src/utils/openaiService.js';
import { logger, sanitizeLogData } from '../src/utils/logger.js';
import { logContextIfVerbose } from '../src/utils/prompting/ContextBuilder.js';
import { SqliteIncidentStore } from '@arete/backend/shared';

const createStubbedOpenAIService = () => {
    const service = new OpenAIService('test-key');
    const openaiStub = {
        responses: {
        create: async (_payload: unknown) => ({
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [
                            {
                                type: 'output_text',
                                text: 'acknowledged'
                            }
                        ],
                        finish_reason: 'stop'
                    }
                ],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5
                }
            })
        }
    };
    // @ts-expect-error overriding private field for testing
    service.openai = openaiStub;

    return service;
};

test('generateResponse logs sanitized metadata without raw message bodies', async () => {
    const service = createStubbedOpenAIService();
    const originalDebug = logger.debug;
    const debugCalls: unknown[][] = [];

    logger.debug = ((...args: unknown[]) => {
        debugCalls.push(args);
        return logger;
    }) as typeof logger.debug;

    const messages: OpenAIMessage[] = [
        { role: 'user', content: 'super secret discord message' }
    ];

    try {
        await service.generateResponse('gpt-5-mini', messages, {});
    } finally {
        logger.debug = originalDebug;
    }

    const payloadLog = debugCalls.find(([firstArg]) =>
        typeof firstArg === 'string' && firstArg.includes('Generating AI response')
    );

    assert.ok(payloadLog, 'Expected sanitized payload log entry to be emitted');

    const flattened = payloadLog
        ?.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg))
        .join(' ');

    assert.ok(
        flattened && !flattened.includes('super secret discord message'),
        'Sanitized payload log should not include raw Discord content'
    );

    const metadata = payloadLog?.find(arg => typeof arg === 'object' && arg !== null) as
        | { model: string; messageCount: number; toolCount: number }
        | undefined;

    assert.ok(metadata, 'Expected metadata object to accompany payload log');
    assert.equal(metadata?.model, 'gpt-5-mini');
    assert.equal(metadata?.messageCount, 1);
    assert.equal(metadata?.toolCount, 0);
});

test('sanitizeLogData redacts Discord snowflake identifiers in strings and objects', () => {
    const raw = 'guild 123456789012345678 channel 234567890123456789';
    const sanitizedString = sanitizeLogData(raw);
    assert.ok(!sanitizedString.includes('123456789012345678'));
    assert.ok(sanitizedString.includes('[REDACTED_ID]'));

    const sanitizedObject = sanitizeLogData({
        guildId: '123456789012345678',
        meta: { channelId: '234567890123456789' }
    });
    const flattened = JSON.stringify(sanitizedObject);
    assert.ok(!flattened.includes('123456789012345678'));
    assert.ok(flattened.includes('[REDACTED_ID]'));
});

test('logger pipeline applies sanitizer before emitting logs', () => {
    const captured: string[] = [];
    const stream = new PassThrough();
    stream.on('data', chunk => {
        captured.push(chunk.toString());
    });
    const streamTransport = new transports.Stream({ stream });

    logger.add(streamTransport);
    try {
        logger.info('Audit for guild 123456789012345678 channel 234567890123456789');
    } finally {
        logger.remove(streamTransport);
    }

    const output = captured.join(' ');
    assert.ok(output.length > 0, 'Expected sanitizer output to be captured');
    assert.ok(!output.match(/\b\d{17,19}\b/), 'Snowflake IDs should be redacted in emitted logs');
    assert.ok(output.includes('[REDACTED_ID]'), 'Redacted placeholder should be present');
});

test('incident store logs do not emit raw Discord IDs', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-logs-'));
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({ dbPath, pseudonymizationSecret: 'privacy-test-secret' });

    const rawGuildId = '123456789012345678';
    const rawChannelId = '234567890123456789';
    const rawMessageId = '345678901234567890';
    const rawUserId = '456789012345678901';

    const captured: string[] = [];
    const stream = new PassThrough();
    stream.on('data', chunk => {
        captured.push(chunk.toString());
    });
    const streamTransport = new transports.Stream({ stream });

    logger.add(streamTransport);
    try {
        const incident = await store.createIncident({
            pointers: {
                guildId: rawGuildId,
                channelId: rawChannelId,
                messageId: rawMessageId
            }
        });

        await store.appendAuditEvent(incident.id, {
            actorHash: rawUserId,
            action: 'audit-log-test'
        });
    } finally {
        logger.remove(streamTransport);
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }

    const output = captured.join(' ');
    assert.ok(output.includes('Incident created'), 'Expected incident log output');
    assert.ok(!output.includes(rawGuildId), 'Raw guild ID should not appear in logs');
    assert.ok(!output.includes(rawChannelId), 'Raw channel ID should not appear in logs');
    assert.ok(!output.includes(rawMessageId), 'Raw message ID should not appear in logs');
    assert.ok(!output.includes(rawUserId), 'Raw user ID should not appear in logs');
});

test('logContextIfVerbose only emits when high verbosity flag is enabled', () => {
    const context: OpenAIMessage[] = [
        { role: 'user', content: 'discord transcript line' }
    ];

    const originalDebug = logger.debug;
    const originalEnv = process.env.DISCORD_BOT_LOG_FULL_CONTEXT;
    const debugCalls: unknown[][] = [];

    logger.debug = ((...args: unknown[]) => {
        debugCalls.push(args);
        return logger;
    }) as typeof logger.debug;

    try {
        delete process.env.DISCORD_BOT_LOG_FULL_CONTEXT;
        logContextIfVerbose(context);
        assert.equal(debugCalls.length, 0, 'High verbosity should be disabled by default');

        process.env.DISCORD_BOT_LOG_FULL_CONTEXT = 'true';
        logContextIfVerbose(context);
        assert.equal(debugCalls.length, 1, 'High verbosity should enable detailed context logging');

        const [logMessage] = debugCalls[0];
        assert.ok(
            typeof logMessage === 'string' && logMessage.includes('Full context'),
            'Verbose log should include the expected prefix'
        );
        assert.ok(
            typeof logMessage === 'string' && logMessage.includes('discord transcript line'),
            'Verbose log should contain the context payload when explicitly enabled'
        );
    } finally {
        if (originalEnv === undefined) {
            delete process.env.DISCORD_BOT_LOG_FULL_CONTEXT;
        } else {
            process.env.DISCORD_BOT_LOG_FULL_CONTEXT = originalEnv;
        }
        logger.debug = originalDebug;
    }
});
