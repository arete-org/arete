/**
 * @description: Verifies canonical conversation context assembly and deterministic projection behavior.
 * @footnote-scope: test
 * @footnote-module: ConversationContextServiceTests
 * @footnote-risk: medium - Regressions can break canonical planner/generation context assembly.
 * @footnote-ethics: high - Identity/visibility regressions could misattribute speakers or leak backend-only context.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostChatRequest } from '@footnote/contracts/web';
import {
    buildConversationContext,
    ConversationContextAssemblyError,
    projectConversationMessages,
} from '../src/services/conversationContextService.js';

const logger = {
    warn: () => undefined,
    debug: () => undefined,
};

const createRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'hello',
    conversation: [{ role: 'user', content: 'hello' }],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

test('buildConversationContext returns canonical messages and envelope metadata', () => {
    const result = buildConversationContext(
        createRequest({
            conversation: [
                {
                    role: 'user',
                    content: 'How are you?',
                    authorName: 'Jordan',
                    authorId: 'user-1',
                },
                {
                    role: 'assistant',
                    content: 'Doing well.',
                    authorName: 'Footnote',
                    authorId: 'bot-1',
                },
            ],
        }),
        logger
    );

    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]?.content, 'How are you?');
    assert.equal(result.messages[1]?.content, 'Doing well.');
    assert.equal(result.contextEnvelope.turns.length, 2);
    assert.equal(result.contextEnvelope.diagnostics.projectedMessageCount, 2);
});

test('buildConversationContext projects speaker labels only for multi-human windows', () => {
    const result = buildConversationContext(
        createRequest({
            conversation: [
                {
                    role: 'user',
                    content: 'First speaker',
                    authorName: 'Jordan',
                    authorId: 'user-1',
                },
                {
                    role: 'user',
                    content: 'Second speaker',
                    authorName: 'Taylor',
                    authorId: 'user-2',
                },
            ],
        }),
        logger
    );

    assert.match(result.messages[0]?.content ?? '', /^\[Jordan\]/);
    assert.match(result.messages[1]?.content ?? '', /^\[Taylor\]/);
    assert.equal(
        result.contextEnvelope.diagnostics.projectedSpeakerLabelCount,
        2
    );
});

test('buildConversationContext sanitizes invalid timestamps without changing role semantics', () => {
    const result = buildConversationContext(
        createRequest({
            conversation: [
                {
                    role: 'assistant',
                    content: 'ok',
                    createdAt: 'not-a-date',
                },
            ],
        }),
        logger
    );

    assert.equal(result.messages[0]?.role, 'assistant');
    assert.equal(result.contextEnvelope.turns[0]?.createdAt, undefined);
    assert.equal(result.contextEnvelope.diagnostics.sanitizedTimestampCount, 1);
});

test('buildConversationContext fails loudly on invalid role identity', () => {
    assert.throws(
        () =>
            buildConversationContext(
                createRequest({
                    conversation: [
                        {
                            role: 'user-ish' as unknown as 'user',
                            content: 'bad',
                        },
                    ],
                }),
                logger
            ),
        (error: unknown) =>
            error instanceof ConversationContextAssemblyError &&
            error.reasonCode === 'invalid_role'
    );
});

test('projectConversationMessages excludes backend_only turns', () => {
    const projected = projectConversationMessages([
        {
            role: 'system',
            content: 'model-visible',
            speakerId: 'system',
            speakerLabel: 'System',
            visibility: 'model_visible',
        },
        {
            role: 'system',
            content: 'must-not-project',
            speakerId: 'system',
            speakerLabel: 'System',
            visibility: 'backend_only',
        },
    ]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.content, 'model-visible');
});
