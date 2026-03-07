/**
 * @description: Covers shared prompt registry loading, override behavior, and canonical reflect prompt availability.
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

import { createPromptRegistry } from '../src/index.js';

test('loads the canonical defaults including reflect.chat.system', () => {
    const registry = createPromptRegistry();

    assert.equal(registry.hasPrompt('reflect.chat.system'), true);
    assert.match(
        registry.renderPrompt('reflect.chat.system').content,
        /You are Footnote, an AI assistant from the Footnote project\./
    );
});

test('merges override files over the canonical defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'override.yaml');

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
        registry.renderPrompt('reflect.chat.system').content,
        /You are Footnote/
    );
});

test('missing override files fail open to defaults', () => {
    const warnings: Array<Record<string, unknown>> = [];
    const registry = createPromptRegistry({
        overridePath: path.join(os.tmpdir(), 'missing-footnote-prompt-file.yaml'),
        logger: {
            warn(message, meta) {
                warnings.push({ message, ...(meta ?? {}) });
            },
        },
    });

    assert.match(
        registry.renderPrompt('discord.chat.system').content,
        /You are Footnote/
    );
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0].message), /Ignoring prompt override file/);
});

test('unknown prompt keys throw a descriptive error', () => {
    const registry = createPromptRegistry();

    assert.throws(
        () => registry.getPrompt('unknown.prompt.key' as never),
        /Prompt not found for key: unknown\.prompt\.key/
    );
});

test('legacy backend and discord default prompt files are gone', () => {
    assert.equal(
        fs.existsSync(
            path.resolve(
                'packages/backend/src/services/prompts/defaults.yaml'
            )
        ),
        false
    );
    assert.equal(
        fs.existsSync(
            path.resolve(
                'packages/discord-bot/src/utils/prompts/defaults.yaml'
            )
        ),
        false
    );
});
