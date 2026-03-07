/**
 * @description: Verifies bot profile env parsing validation, precedence, and fail-open behavior.
 * @footnote-scope: test
 * @footnote-module: BotProfileConfigTests
 * @footnote-risk: low - These tests validate deterministic env parsing only.
 * @footnote-ethics: medium - Correct profile parsing protects identity and prompt-overlay intent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    parseBotProfileConfig,
    readBotProfileConfig,
    type BotProfileConfig,
} from '../src/config/profile.js';

test('readBotProfileConfig applies defaults when env values are missing', () => {
    const parsed = readBotProfileConfig({
        env: {},
    });

    const expected: BotProfileConfig = {
        id: 'footnote',
        displayName: 'Footnote',
        mentionAliases: [],
        promptOverlay: {
            source: 'none',
            text: null,
            path: null,
            length: 0,
        },
    };

    assert.deepEqual(parsed, expected);
});

test('parseBotProfileConfig is pure and applies inline-overlay precedence', () => {
    const parsed = parseBotProfileConfig({
        profileId: 'ARI-vendor',
        profileDisplayName: '  Ari  ',
        inlineOverlayText: '  inline wins  ',
        overlayPath: '/tmp/vendor.txt',
        overlayFileText: 'file text',
    });

    assert.deepEqual(parsed, {
        id: 'ari-vendor',
        displayName: 'Ari',
        mentionAliases: [],
        promptOverlay: {
            source: 'inline',
            text: 'inline wins',
            path: null,
            length: 'inline wins'.length,
        },
    });
});

test('readBotProfileConfig normalizes id and display name with validation', () => {
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_ID: '  ARI-vendor  ',
            BOT_PROFILE_DISPLAY_NAME: '  Ari  ',
        },
    });

    const expected: BotProfileConfig = {
        id: 'ari-vendor',
        displayName: 'Ari',
        mentionAliases: [],
        promptOverlay: {
            source: 'none',
            text: null,
            path: null,
            length: 0,
        },
    };

    assert.deepEqual(parsed, expected);
});

test('readBotProfileConfig falls back for invalid id and long display name', () => {
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_ID: 'ari_vendor',
            BOT_PROFILE_DISPLAY_NAME: 'x'.repeat(65),
        },
    });

    const expected: BotProfileConfig = {
        id: 'footnote',
        displayName: 'Footnote',
        mentionAliases: [],
        promptOverlay: {
            source: 'none',
            text: null,
            path: null,
            length: 0,
        },
    };

    assert.deepEqual(parsed, expected);
});

test('readBotProfileConfig prefers inline overlay over file overlay', () => {
    let readFileCalls = 0;
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_PROMPT_OVERLAY: '  inline instructions  ',
            BOT_PROFILE_PROMPT_OVERLAY_PATH: './prompts/ari.txt',
        },
        readFile: (_resolvedPath) => {
            readFileCalls += 1;
            return 'should not be loaded';
        },
    });

    assert.equal(readFileCalls, 0);
    assert.deepEqual(parsed.promptOverlay, {
        source: 'inline',
        text: 'inline instructions',
        path: null,
        length: 'inline instructions'.length,
    });
    assert.deepEqual(parsed.mentionAliases, []);
});

test('readBotProfileConfig resolves and reads file overlay when inline is absent', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-profile-'));
    const overlayDir = path.join(tmpRoot, 'overlays');
    fs.mkdirSync(overlayDir, { recursive: true });
    const overlayPath = path.join(overlayDir, 'vendor.txt');
    fs.writeFileSync(overlayPath, '\nfile overlay\n', 'utf-8');

    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_PROMPT_OVERLAY_PATH: './overlays/vendor.txt',
        },
        projectRoot: tmpRoot,
    });

    assert.deepEqual(parsed.promptOverlay, {
        source: 'file',
        text: 'file overlay',
        path: overlayPath,
        length: 'file overlay'.length,
    });
    assert.deepEqual(parsed.mentionAliases, []);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('readBotProfileConfig fails open when file overlay cannot be read', () => {
    const projectRoot = path.resolve('C:/repo');
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_PROMPT_OVERLAY_PATH: './missing.txt',
        },
        projectRoot,
        readFile: () => {
            throw new Error('ENOENT');
        },
    });

    assert.deepEqual(parsed.promptOverlay, {
        source: 'none',
        text: null,
        path: path.resolve(projectRoot, './missing.txt'),
        length: 0,
    });
    assert.deepEqual(parsed.mentionAliases, []);
});

test('readBotProfileConfig ignores over-limit overlays', () => {
    const parsedFromInline = readBotProfileConfig({
        env: {
            BOT_PROFILE_PROMPT_OVERLAY: 'x'.repeat(9),
        },
        maxOverlayLength: 8,
    });

    assert.deepEqual(parsedFromInline.promptOverlay, {
        source: 'none',
        text: null,
        path: null,
        length: 0,
    });
    assert.deepEqual(parsedFromInline.mentionAliases, []);

    const parsedFromFile = readBotProfileConfig({
        env: {
            BOT_PROFILE_PROMPT_OVERLAY_PATH: './too-long.txt',
        },
        projectRoot: '/tmp',
        maxOverlayLength: 8,
        readFile: () => '0123456789',
    });

    assert.deepEqual(parsedFromFile.promptOverlay, {
        source: 'none',
        text: null,
        path: path.resolve('/tmp', './too-long.txt'),
        length: 0,
    });
    assert.deepEqual(parsedFromFile.mentionAliases, []);
});

test('parseBotProfileConfig falls back to none when file text is missing', () => {
    const parsed = parseBotProfileConfig({
        profileId: 'vendor',
        profileDisplayName: 'Vendor',
        overlayPath: '/tmp/missing.txt',
        overlayFileText: null,
    });

    assert.deepEqual(parsed.promptOverlay, {
        source: 'none',
        text: null,
        path: '/tmp/missing.txt',
        length: 0,
    });
    assert.deepEqual(parsed.mentionAliases, []);
});

test('readBotProfileConfig normalizes and dedupes mention aliases', () => {
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_MENTION_ALIASES:
                '  Ari , foot note, ARI,   Foot  Note  ,  ',
        },
    });

    assert.deepEqual(parsed.mentionAliases, ['ari', 'foot note']);
});

test('readBotProfileConfig falls back to empty aliases for blank csv input', () => {
    const parsed = readBotProfileConfig({
        env: {
            BOT_PROFILE_MENTION_ALIASES: ' ,   , ',
        },
    });

    assert.deepEqual(parsed.mentionAliases, []);
});

test('runtimeConfig no longer exposes botMentionNames', async () => {
    const originalEnv = { ...process.env };
    process.env.DISCORD_TOKEN = 'token';
    process.env.DISCORD_CLIENT_ID = 'client-id';
    process.env.DISCORD_GUILD_ID = 'guild-id';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.DISCORD_USER_ID = 'user-id';
    process.env.INCIDENT_PSEUDONYMIZATION_SECRET = 'secret';

    try {
        const runtimeModuleUrl = new URL(
            '../src/config/runtime.js',
            import.meta.url
        );
        runtimeModuleUrl.searchParams.set('test', String(Date.now()));
        const { runtimeConfig } = (await import(
            runtimeModuleUrl.href
        )) as typeof import('../src/config/runtime.js');

        assert.equal('botMentionNames' in runtimeConfig, false);
        assert.ok(Array.isArray(runtimeConfig.profile.mentionAliases));
    } finally {
        process.env = originalEnv;
    }
});
