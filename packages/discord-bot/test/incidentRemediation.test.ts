/**
 * @description: Verifies automatic under-review edits for reported assistant messages.
 * @footnote-scope: test
 * @footnote-module: IncidentRemediationTests
 * @footnote-risk: low - Test-only coverage for Discord message edit helpers.
 * @footnote-ethics: high - Confirms incident remediation stays idempotent and avoids editing the wrong message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildUnderReviewContent,
    remediateReportedAssistantMessage,
    UNDER_REVIEW_MARKER,
} from '../src/utils/response/incidentRemediation.js';

test('buildUnderReviewContent prefers spoiler wrapping when the content is safe to hide inline', () => {
    const result = buildUnderReviewContent('Original assistant reply');

    assert.equal(result.usedPlaceholder, false);
    assert.match(result.content, /\|\|Original assistant reply\|\|/);
});

test('buildUnderReviewContent falls back to a placeholder for malformed spoiler content', () => {
    const result = buildUnderReviewContent('Original || assistant || reply');

    assert.equal(result.usedPlaceholder, true);
    assert.doesNotMatch(result.content, /\|\|Original \|\| assistant/);
});

test('remediateReportedAssistantMessage skips non-assistant-authored messages', async () => {
    const message = {
        client: { user: { id: 'bot-user' } },
        author: { id: 'human-user' },
        content: 'hello',
        edit: async () => undefined,
    };

    const outcome = await remediateReportedAssistantMessage(message as never);
    assert.equal(outcome.state, 'skipped_not_assistant');
});

test('remediateReportedAssistantMessage is idempotent when the message is already marked', async () => {
    const message = {
        client: { user: { id: 'bot-user' } },
        author: { id: 'bot-user' },
        content: `⚠️ ${UNDER_REVIEW_MARKER} and may contain harmful or incorrect guidance.`,
        edit: async () => undefined,
    };

    const outcome = await remediateReportedAssistantMessage(message as never);
    assert.equal(outcome.state, 'already_marked');
});

test('remediateReportedAssistantMessage edits assistant messages once', async () => {
    let editedContent = '';
    const message = {
        client: { user: { id: 'bot-user' } },
        author: { id: 'bot-user' },
        content: 'Original assistant reply',
        edit: async ({ content }: { content: string }) => {
            editedContent = content;
        },
    };

    const outcome = await remediateReportedAssistantMessage(message as never);
    assert.equal(outcome.state, 'applied');
    assert.match(editedContent, /Under review/);
});
