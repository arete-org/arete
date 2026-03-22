/**
 * @description: Verifies Discord prompt wiring uses the shared canonical catalog and stays aligned with backend overrides.
 * @footnote-scope: test
 * @footnote-module: DiscordPromptRegistryParityTests
 * @footnote-risk: medium - Missing tests here can let bot-local prompts drift from backend defaults again.
 * @footnote-ethics: high - Prompt parity is required so local bot behavior stays aligned with canonical Footnote instructions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPromptRegistry } from '@footnote/prompts';
import { createDiscordPromptRegistry } from '../src/config/promptRegistryFactory.js';

test('discord prompt registry renders the same canonical base prompt as the shared package', () => {
    const sharedRegistry = createPromptRegistry();
    const discordRegistry = createDiscordPromptRegistry(undefined);

    assert.equal(
        discordRegistry.renderPrompt('conversation.shared.system').content,
        sharedRegistry.renderPrompt('conversation.shared.system').content
    );
    assert.equal(
        discordRegistry.renderPrompt('conversation.shared.persona.footnote')
            .content,
        sharedRegistry.renderPrompt('conversation.shared.persona.footnote')
            .content
    );
    assert.equal(
        discordRegistry.renderPrompt('discord.chat.system').content,
        sharedRegistry.renderPrompt('discord.chat.system').content
    );
    assert.equal(
        discordRegistry.renderPrompt('discord.image.system').content,
        sharedRegistry.renderPrompt('discord.image.system').content
    );
    assert.equal(
        discordRegistry.renderPrompt('discord.chat.persona.footnote').content,
        sharedRegistry.renderPrompt('discord.chat.persona.footnote').content
    );
    assert.equal(
        discordRegistry.renderPrompt('discord.image.persona.footnote').content,
        sharedRegistry.renderPrompt('discord.image.persona.footnote').content
    );
    assert.equal(
        discordRegistry.renderPrompt(
            'discord.realtime.persona.footnote'
        ).content,
        sharedRegistry.renderPrompt('discord.realtime.persona.footnote').content
    );
});

test('discord prompt registry honors the same override format as the shared package', () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-shared-prompts-')
    );
    const overridePath = path.join(tempDir, 'override.yaml');

    fs.writeFileSync(
        overridePath,
        [
            'discord:',
            '  chat:',
            '    system:',
            '      template: |-',
            '        Shared override chat prompt.',
        ].join('\n'),
        'utf8'
    );

    const sharedRegistry = createPromptRegistry({ overridePath });
    const discordRegistry = createDiscordPromptRegistry(overridePath);

    assert.equal(
        sharedRegistry.renderPrompt('discord.chat.system').content,
        'Shared override chat prompt.'
    );
    assert.equal(
        discordRegistry.renderPrompt('discord.chat.system').content,
        'Shared override chat prompt.'
    );
});
