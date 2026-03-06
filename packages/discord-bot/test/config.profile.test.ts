/**
 * @description: Verifies bot profile env parsing defaults and normalization behavior.
 * @footnote-scope: test
 * @footnote-module: BotProfileConfigTests
 * @footnote-risk: low - These tests validate deterministic env parsing only.
 * @footnote-ethics: medium - Correct profile parsing protects identity and prompt-overlay intent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    readBotProfileConfig,
    type BotProfileConfig,
} from '../src/config/profile.js';

test('readBotProfileConfig applies defaults when env values are missing', () => {
    const parsed = readBotProfileConfig({});

    const expected: BotProfileConfig = {
        id: 'footnote',
        displayName: 'Footnote',
        promptOverlayText: null,
        promptOverlayPath: null,
    };

    assert.deepEqual(parsed, expected);
});

test('readBotProfileConfig trims env values and preserves non-empty strings', () => {
    const parsed = readBotProfileConfig({
        BOT_PROFILE_ID: '  ari-vendor  ',
        BOT_PROFILE_DISPLAY_NAME: '  Ari  ',
        BOT_PROFILE_PROMPT_OVERLAY: '  keep this overlay  ',
        BOT_PROFILE_PROMPT_OVERLAY_PATH: '  ./prompts/ari.txt  ',
    });

    const expected: BotProfileConfig = {
        id: 'ari-vendor',
        displayName: 'Ari',
        promptOverlayText: 'keep this overlay',
        promptOverlayPath: './prompts/ari.txt',
    };

    assert.deepEqual(parsed, expected);
});

test('readBotProfileConfig treats blank strings as missing', () => {
    const parsed = readBotProfileConfig({
        BOT_PROFILE_ID: '   ',
        BOT_PROFILE_DISPLAY_NAME: '   ',
        BOT_PROFILE_PROMPT_OVERLAY: '   ',
        BOT_PROFILE_PROMPT_OVERLAY_PATH: '\t',
    });

    const expected: BotProfileConfig = {
        id: 'footnote',
        displayName: 'Footnote',
        promptOverlayText: null,
        promptOverlayPath: null,
    };

    assert.deepEqual(parsed, expected);
});
