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
    renderPromptLayersWithActivePersona,
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

test('shared override + active persona layer preserve expected precedence', () => {
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

        const composedPrompt = renderPromptLayersWithActivePersona({
            registry,
            profile,
            systemKeys: ['discord.image.system'],
            personaKeys: ['discord.image.persona.footnote'],
            usage: 'image.system',
            variables: {
                botProfileDisplayName: profile.displayName,
            },
        });
        const reflectConversation =
            prependProfileOverlaySystemMessageToConversation(profile, 'chat', [
                { role: 'user', content: 'hello' },
            ]);

        assert.match(composedPrompt, /Override image prompt for Vendor Bot\./);
        assert.match(composedPrompt, /BEGIN Bot Profile Overlay/);
        assert.match(composedPrompt, /Usage Context: image\.system/);
        assert.doesNotMatch(
            composedPrompt,
            /You are Vendor Bot, the Discord voice of the Footnote project\./
        );
        assert.equal(reflectConversation.overlayAdded, true);
        assert.equal(reflectConversation.conversation[0].role, 'system');
        assert.match(
            reflectConversation.conversation[0].content,
            /Usage Context: chat/
        );
        assert.equal(reflectConversation.conversation[1].content, 'hello');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('malformed shared overrides fail open while active persona overlays still apply', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'invalid-override.yaml');

    try {
        fs.writeFileSync(
            overridePath,
            ['discord:', '  image:', '    system:', '      template: 123'].join(
                '\n'
            ),
            'utf8'
        );

        const registry = createDiscordPromptRegistry(overridePath);
        const prompt = renderPromptLayersWithActivePersona({
            registry,
            profile: createProfile(),
            systemKeys: ['discord.image.system'],
            personaKeys: ['discord.image.persona.footnote'],
            usage: 'image.system',
            variables: {
                botProfileDisplayName: 'Footnote',
            },
        });

        assert.match(
            prompt,
            /You are the image-generation orchestration system for a configured Discord bot profile\./
        );
        assert.match(prompt, /BEGIN Bot Profile Overlay/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
