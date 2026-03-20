/**
 * @description: Verifies backend-owned bot profile parsing for image prompt composition.
 * @footnote-scope: test
 * @footnote-module: BackendBotProfileConfigTests
 * @footnote-risk: medium - Missing tests could let backend prompt ownership drift from configured profile behavior.
 * @footnote-ethics: medium - Profile parsing shapes identity and overlay application.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseBotProfileConfig,
    readBotProfileConfig,
} from '../src/config/profile.js';

test('readBotProfileConfig applies defaults when env values are missing', () => {
    const warnings: string[] = [];
    const parsed = readBotProfileConfig({
        env: {},
        projectRoot: process.cwd(),
        warn(message) {
            warnings.push(message);
        },
    });

    assert.equal(parsed.id, 'footnote');
    assert.equal(parsed.displayName, 'Footnote');
    assert.deepEqual(parsed.mentionAliases, []);
    assert.equal(parsed.promptOverlay.source, 'none');
    assert.equal(warnings.length, 0);
});

test('parseBotProfileConfig prefers inline overlay over file overlay', () => {
    const parsed = parseBotProfileConfig({
        profileId: 'ari-vendor',
        profileDisplayName: 'Ari',
        mentionAliasesCsv: 'ari, Ari',
        inlineOverlayText: '  inline instructions  ',
        overlayPath: './overlay.txt',
        overlayFileText: 'file instructions',
    });

    assert.equal(parsed.id, 'ari-vendor');
    assert.equal(parsed.displayName, 'Ari');
    assert.deepEqual(parsed.mentionAliases, ['ari']);
    assert.deepEqual(parsed.promptOverlay, {
        source: 'inline',
        text: 'inline instructions',
        path: null,
        length: 19,
    });
});

test('parseBotProfileConfig uses a trimmed file overlay when no inline overlay is present', () => {
    const parsed = parseBotProfileConfig({
        profileId: 'ari-vendor',
        profileDisplayName: 'Ari',
        mentionAliasesCsv: 'ari, Ari',
        overlayPath: './overlay.txt',
        overlayFileText: '  file instructions  ',
    });

    assert.equal(parsed.id, 'ari-vendor');
    assert.equal(parsed.displayName, 'Ari');
    assert.deepEqual(parsed.mentionAliases, ['ari']);
    assert.deepEqual(parsed.promptOverlay, {
        source: 'file',
        text: 'file instructions',
        path: './overlay.txt',
        length: 17,
    });
});

test('readBotProfileConfig fails open when file overlay cannot be read', () => {
    const warnings: string[] = [];
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_PROMPT_OVERLAY_PATH: './missing.txt',
        },
        projectRoot: process.cwd(),
        warn(message) {
            warnings.push(message);
        },
        readFile() {
            throw new Error('ENOENT');
        },
    });

    assert.equal(parsed.promptOverlay.source, 'none');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not read BOT_PROFILE_PROMPT_OVERLAY_PATH/);
});
