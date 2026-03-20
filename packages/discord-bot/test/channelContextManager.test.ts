/**
 * @description: Verifies ChannelContextManager keeps rolling human/bot counters aligned with the retained message buffer.
 * @footnote-scope: test
 * @footnote-module: ChannelContextManagerTests
 * @footnote-risk: medium - Drift in rolling counters would make engagement decisions use stale channel composition.
 * @footnote-ethics: high - Incorrect rolling metrics can make the bot intrude on conversations it should leave alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ChannelContextManager } from '../src/state/ChannelContextManager.js';

const createMessage = (
    id: string,
    options: {
        isBot?: boolean;
        timestamp?: number;
        username?: string;
        content?: string;
    } = {}
) =>
    ({
        id,
        content: options.content ?? id,
        createdTimestamp: options.timestamp ?? Date.now(),
        author: {
            id: `${id}-author`,
            username: options.username ?? id,
            bot: options.isBot ?? false,
        },
    }) as never;

test('recordMessage recomputes rolling counters after max-buffer trimming', () => {
    const manager = new ChannelContextManager({
        enabled: true,
        maxMessagesPerChannel: 2,
        messageRetentionMs: 60_000,
        evictionIntervalMs: 60_000,
    });

    manager.recordMessage('guild-1:channel-1', createMessage('human-1'));
    manager.recordMessage(
        'guild-1:channel-1',
        createMessage('bot-1', { isBot: true })
    );
    manager.recordMessage(
        'guild-1:channel-1',
        createMessage('bot-2', { isBot: true })
    );

    const metrics = manager.getMetrics('guild-1:channel-1');
    const recentMessages = manager.getRecentMessages('guild-1:channel-1');

    assert.ok(metrics);
    assert.equal(metrics.windowTotalMessages, 2);
    assert.equal(metrics.windowBotMessages, 2);
    assert.equal(metrics.windowHumanMessages, 0);
    assert.deepEqual(
        recentMessages.map((message) => message.id),
        ['bot-1', 'bot-2']
    );
});

test('evictExpired recomputes rolling counters after time-based eviction', () => {
    const originalDateNow = Date.now;
    const manager = new ChannelContextManager({
        enabled: true,
        maxMessagesPerChannel: 5,
        messageRetentionMs: 1_000,
        evictionIntervalMs: 10_000,
    });

    try {
        Date.now = () => 1_400;

        manager.recordMessage(
            'guild-1:channel-1',
            createMessage('human-1', { timestamp: 0 })
        );
        manager.recordMessage(
            'guild-1:channel-1',
            createMessage('bot-1', { isBot: true, timestamp: 500 })
        );

        manager.evictExpired();

        const metrics = manager.getMetrics('guild-1:channel-1');
        const recentMessages = manager.getRecentMessages('guild-1:channel-1');

        assert.ok(metrics);
        assert.equal(metrics.windowTotalMessages, 1);
        assert.equal(metrics.windowBotMessages, 1);
        assert.equal(metrics.windowHumanMessages, 0);
        assert.deepEqual(
            recentMessages.map((message) => message.id),
            ['bot-1']
        );
    } finally {
        Date.now = originalDateNow;
    }
});

test('getMetrics matches the retained buffer after mixed human and bot traffic', () => {
    const manager = new ChannelContextManager({
        enabled: true,
        maxMessagesPerChannel: 5,
        messageRetentionMs: 60_000,
        evictionIntervalMs: 60_000,
    });

    manager.recordMessage('guild-1:channel-1', createMessage('human-1'));
    manager.recordMessage(
        'guild-1:channel-1',
        createMessage('bot-1', { isBot: true })
    );
    manager.recordMessage('guild-1:channel-1', createMessage('human-2'));
    manager.recordMessage(
        'guild-1:channel-1',
        createMessage('bot-2', { isBot: true })
    );

    const metrics = manager.getMetrics('guild-1:channel-1');
    const recentMessages = manager.getRecentMessages('guild-1:channel-1');
    const botMessages = recentMessages.filter((message) => message.isBot).length;
    const humanMessages = recentMessages.length - botMessages;

    assert.ok(metrics);
    assert.equal(metrics.windowTotalMessages, recentMessages.length);
    assert.equal(metrics.windowBotMessages, botMessages);
    assert.equal(metrics.windowHumanMessages, humanMessages);
});

test('recordLLMUsage aggregates session totals for Discord-local helper calls', () => {
    const manager = new ChannelContextManager({
        enabled: true,
        maxMessagesPerChannel: 5,
        messageRetentionMs: 60_000,
        evictionIntervalMs: 60_000,
    });

    manager.recordLLMUsage({
        feature: 'embedding',
        model: 'text-embedding-3-small',
        promptTokens: 12,
        completionTokens: 0,
        totalTokens: 12,
        inputCostUsd: 0.00000024,
        outputCostUsd: 0,
        totalCostUsd: 0.00000024,
        estimated: false,
        timestamp: Date.now(),
    });
    manager.recordLLMUsage({
        feature: 'tts',
        model: 'gpt-4o-mini-tts',
        promptTokens: 20,
        completionTokens: 0,
        totalTokens: 20,
        inputCostUsd: 0.000012,
        outputCostUsd: 0,
        totalCostUsd: 0.000012,
        estimated: true,
        timestamp: Date.now(),
    });

    assert.deepEqual(manager.getLLMUsageTotals(), {
        totalCostUsd: 0.00001224,
        totalCalls: 2,
        totalTokensIn: 32,
        totalTokensOut: 0,
    });
});
