/**
 * @description: Validates prompt precedence behavior across shared overrides and profile overlays.
 * @footnote-scope: test
 * @footnote-module: PromptCompositionIntegrationTests
 * @footnote-risk: medium - Missing tests can hide prompt precedence regressions across Discord paths.
 * @footnote-ethics: high - Prompt precedence governs safety and identity behavior shown to users.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDiscordPromptRegistry } from '../src/config/promptRegistryFactory.js';
import {
    prependProfileOverlaySystemMessageToConversation,
    renderPromptWithAppendedProfileOverlay,
} from '../src/config/promptComposition.js';
import type { BotProfileConfig } from '../src/config/profile.js';

const createProfile = (): BotProfileConfig => ({
    id: 'vendor-bot',
    displayName: 'Vendor Bot',
    mentionAliases: [],
    promptOverlay: {
        source: 'inline',
        text: 'Prefer the vendor voice while keeping Footnote guardrails.',
        path: null,
        length: 57,
    },
});

test('shared override + variable interpolation + profile overlay preserve expected precedence', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'override.yaml');

    try {
        fs.writeFileSync(
            overridePath,
            [
                'discord:',
                '  image:',
                '    system:',
                '      template: |-',
                '        Override image prompt for {{botProfileDisplayName}}.',
            ].join('\n'),
            'utf8'
        );

        const registry = createDiscordPromptRegistry(overridePath);
        const profile = createProfile();

        const appendedPrompt = renderPromptWithAppendedProfileOverlay({
            registry,
            profile,
            key: 'discord.image.system',
            usage: 'image.system',
            variables: {
                botProfileDisplayName: profile.displayName,
            },
        });
        const reflectConversation =
            prependProfileOverlaySystemMessageToConversation(
                profile,
                'reflect',
                [{ role: 'user', content: 'hello' }]
            );

        assert.match(appendedPrompt, /Override image prompt for Vendor Bot\./);
        assert.match(appendedPrompt, /BEGIN Bot Profile Overlay/);
        assert.match(appendedPrompt, /Usage Context: image\.system/);
        assert.equal(reflectConversation.overlayAdded, true);
        assert.equal(reflectConversation.conversation[0].role, 'system');
        assert.match(
            reflectConversation.conversation[0].content,
            /Usage Context: reflect/
        );
        assert.equal(reflectConversation.conversation[1].content, 'hello');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('malformed shared overrides fail open while append-path overlays still apply', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'invalid-override.yaml');

    try {
        fs.writeFileSync(
            overridePath,
            [
                'discord:',
                '  image:',
                '    system:',
                '      template: 123',
            ].join('\n'),
            'utf8'
        );

        const registry = createDiscordPromptRegistry(overridePath);
        const prompt = renderPromptWithAppendedProfileOverlay({
            registry,
            profile: createProfile(),
            key: 'discord.image.system',
            usage: 'image.system',
            variables: {
                botProfileDisplayName: 'Footnote',
            },
        });

        assert.match(prompt, /You are Footnote/);
        assert.match(prompt, /BEGIN Bot Profile Overlay/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
