/**
 * @description: Verifies the shared bot profile parser and overlay formatter used by backend and Discord.
 * @footnote-scope: test
 * @footnote-module: SharedBotProfileConfigTests
 * @footnote-risk: low - These tests only exercise deterministic parsing and prompt formatting.
 * @footnote-ethics: medium - Shared profile behavior affects identity and disclosure across runtimes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    buildProfileOverlaySystemMessage,
    parseBotProfileConfig,
    readBotProfileConfig,
} from '../src/bot-profile.js';

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

test('readBotProfileConfig fails open when file overlay cannot be read', () => {
    const warnings: string[] = [];
    const projectRoot = process.cwd();
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_PROMPT_OVERLAY_PATH: './missing.txt',
        },
        projectRoot,
        warn(message) {
            warnings.push(message);
        },
        readFile() {
            throw new Error('ENOENT');
        },
    });

    assert.deepEqual(parsed.promptOverlay, {
        source: 'none',
        text: null,
        path: path.resolve(projectRoot, './missing.txt'),
        length: 0,
    });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /Could not read BOT_PROFILE_PROMPT_OVERLAY_PATH/);
    assert.match(warnings[1], /Ignoring BOT_PROFILE_PROMPT_OVERLAY_PATH/);
});

test('buildProfileOverlaySystemMessage includes metadata and the precedence reminder', () => {
    const message = buildProfileOverlaySystemMessage(
        {
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: [],
            promptOverlay: {
                source: 'inline',
                text: 'Use the Ari profile when this runtime is configured for it.',
                path: null,
                length: 57,
            },
        },
        'image.system'
    );

    assert.ok(message);
    assert.match(message, /BEGIN Bot Profile Overlay/);
    assert.match(message, /Usage Context: image\.system/);
    assert.match(message, /Profile Display Name: Ari/);
    assert.match(
        message,
        /Base Footnote safety, provenance, and system constraints take precedence/
    );
});
