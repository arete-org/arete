/**
 * @description: Covers shared prompt registry loading, override behavior, and canonical chat prompt availability.
 * @footnote-scope: test
 * @footnote-module: SharedPromptRegistryTests
 * @footnote-risk: medium - Missing tests here can let backend and bot prompt ownership drift again.
 * @footnote-ethics: high - Canonical prompt defaults must stay stable and fail open when overrides break.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPromptRegistry } from '../src/index.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, '..', '..', '..');

test('loads shared conversational prompts plus surface supplements', () => {
    const registry = createPromptRegistry();

    assert.equal(registry.hasPrompt('conversation.shared.system'), true);
    assert.equal(
        registry.hasPrompt('conversation.shared.persona.footnote'),
        true
    );
    assert.equal(registry.hasPrompt('chat.web.system'), true);
    assert.equal(registry.hasPrompt('chat.web.persona.footnote'), true);
    assert.equal(registry.hasPrompt('discord.image.persona.footnote'), true);
    assert.equal(registry.hasPrompt('discord.realtime.persona.footnote'), true);
    assert.match(
        registry.renderPrompt('conversation.shared.system', {
            botProfileDisplayName: 'Footnote',
        }).content,
        /You are the response engine for a configured Footnote assistant\./
    );
    assert.match(
        registry.renderPrompt('chat.web.system', {
            botProfileDisplayName: 'Footnote',
        }).content,
        /CITATION STYLE/
    );
    assert.match(
        registry.renderPrompt('conversation.shared.persona.footnote', {
            botProfileDisplayName: 'Footnote',
        }).content,
        /You are Footnote, part of the Footnote project\./
    );
});

test('merges override files over the canonical defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'override.yaml');
    try {
        fs.writeFileSync(
            overridePath,
            [
                'discord:',
                '  chat:',
                '    system:',
                '      template: |-',
                '        Override chat prompt.',
            ].join('\n'),
            'utf8'
        );

        const registry = createPromptRegistry({ overridePath });

        assert.equal(
            registry.renderPrompt('discord.chat.system').content,
            'Override chat prompt.'
        );
        assert.match(
            registry.renderPrompt('chat.web.persona.footnote', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /In web chat, favor explicit reasoning/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('missing override files fail open to defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'missing-override.yaml');
    const warnings: Array<Record<string, unknown>> = [];
    try {
        const registry = createPromptRegistry({
            overridePath,
            logger: {
                warn(message, meta) {
                    warnings.push({ message, ...(meta ?? {}) });
                },
            },
        });

        assert.match(
            registry.renderPrompt('discord.chat.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /Formatting and citations:/
        );
        assert.equal(warnings.length, 1);
        assert.match(
            String(warnings[0].message),
            /Ignoring prompt override file/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('invalid override entries are warned and skipped while valid entries still apply', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'override-invalid.yaml');
    const warnings: Array<Record<string, unknown>> = [];
    try {
        fs.writeFileSync(
            overridePath,
            [
                'discord:',
                '  chat:',
                '    system:',
                '      template: 123',
                '  image:',
                '    system:',
                '      template: |-',
                '        Invalid cache override',
                '      cache: not-an-object',
                'chat:',
                '  web:',
                '    system:',
                '      template: |-',
                '        Web chat override prompt.',
                'unknown:',
                '  chat:',
                '    system:',
                '      template: |-',
                '        Unknown key prompt.',
            ].join('\n'),
            'utf8'
        );

        const registry = createPromptRegistry({
            overridePath,
            logger: {
                warn(message, meta) {
                    warnings.push({ message, ...(meta ?? {}) });
                },
            },
        });

        assert.equal(
            registry.renderPrompt('chat.web.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            'Web chat override prompt.'
        );
        assert.match(
            registry.renderPrompt('discord.chat.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /Formatting and citations:/
        );
        assert.match(
            registry.renderPrompt('discord.image.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /You are the image-generation orchestration system for a configured Discord bot profile\./
        );
        assert.ok(
            warnings.some(
                (warning) =>
                    String(warning.message) ===
                    'Ignoring invalid prompt override entry.'
            )
        );
        assert.ok(
            warnings.some(
                (warning) =>
                    String(warning.message) ===
                    'Ignoring unknown prompt override key.'
            )
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('unknown prompt keys throw a descriptive error', () => {
    const registry = createPromptRegistry();

    assert.throws(
        () => registry.getPrompt('unknown.prompt.key' as never),
        /Prompt not found for key: unknown\.prompt\.key/
    );
});

test('legacy backend and discord default prompt files are gone', () => {
    const legacyBackendDefaultsPath = path.resolve(
        repoRoot,
        'packages',
        'backend',
        'src',
        'services',
        'prompts',
        'defaults.yaml'
    );
    const legacyDiscordDefaultsPath = path.resolve(
        repoRoot,
        'packages',
        'discord-bot',
        'src',
        'utils',
        'prompts',
        'defaults.yaml'
    );

    assert.equal(fs.existsSync(legacyBackendDefaultsPath), false);
    assert.equal(fs.existsSync(legacyDiscordDefaultsPath), false);
});
