/**
 * @description: Verifies that the catchup filter treats common emoji modifier sequences as emoji-only content.
 * @footnote-scope: test
 * @footnote-module: CatchupFilterTests
 * @footnote-risk: low - These tests only validate deterministic catchup heuristics.
 * @footnote-ethics: medium - Correct emoji-only detection helps avoid unnecessary bot replies in human conversations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CatchupFilter } from '../src/utils/CatchupFilter.js';

interface CatchupMessageLike {
    attachments: { size: number };
    author: { bot: boolean };
    content: string;
}

function createMessage(content: string): CatchupMessageLike {
    return {
        attachments: { size: 0 },
        author: { bot: false },
        content,
    };
}

function isEmojiOnly(message: CatchupMessageLike): boolean {
    const filter = new CatchupFilter();
    const emojiOnlyMethod = Reflect.get(filter as object, 'isEmojiOnly') as (
        message: CatchupMessageLike
    ) => boolean;

    return emojiOnlyMethod.call(filter, message);
}

test('isEmojiOnly accepts emoji with skin-tone modifiers', () => {
    assert.equal(isEmojiOnly(createMessage('👍🏻')), true);
});

test('isEmojiOnly accepts emoji modifier and ZWJ chains', () => {
    assert.equal(isEmojiOnly(createMessage('👨🏽‍💻 👩🏻‍💻')), true);
});
