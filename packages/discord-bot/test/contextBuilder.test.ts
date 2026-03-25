/**
 * @description: Verifies Discord text context building includes the shared
 * conversational prompt core before surface-specific chat rules.
 * @footnote-scope: test
 * @footnote-module: ContextBuilderTests
 * @footnote-risk: medium - Missing tests could let Discord text prompt layers drift from the shared conversational model.
 * @footnote-ethics: high - Prompt-layer regressions can silently remove shared safety and truthfulness guidance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextBuilder } from '../src/utils/prompting/ContextBuilder.js';

test('ContextBuilder includes shared conversational system prompt before Discord chat rules', async () => {
    const builder = new ContextBuilder();

    const message = {
        id: 'message-1',
        content: 'What changed?',
        createdTimestamp: Date.now(),
        reference: null,
        author: {
            id: 'user-1',
            username: 'Jordan',
        },
        member: {
            displayName: 'Jordan',
        },
        client: {
            user: {
                id: 'bot-1',
            },
        },
        channel: {
            messages: {
                fetch: async () => new Map(),
            },
        },
    } as never;

    const { context } = await builder.buildMessageContext(message, 4);

    assert.equal(context[0]?.role, 'system');
    assert.match(
        context[0]?.content ?? '',
        /You are the response engine for a configured Footnote assistant\./
    );
    assert.match(context[0]?.content ?? '', /Formatting and citations:/);
    assert.ok(
        (context[0]?.content ?? '').indexOf(
            'You are the response engine for a configured Footnote assistant.'
        ) <
            (context[0]?.content ?? '').indexOf('Formatting and citations:'),
        'Shared conversational rules should appear before Discord chat rules'
    );
});
