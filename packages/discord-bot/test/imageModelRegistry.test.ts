/**
 * @description: Verifies the Discord image command exposes the same curated model lists as the shared contracts registry.
 * @footnote-scope: test
 * @footnote-module: ImageModelRegistryTests
 * @footnote-risk: low - These tests only check that shared model lists stay aligned.
 * @footnote-ethics: low - Model-choice consistency supports clear user expectations but does not execute generation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    internalImageRenderModels,
    internalImageTextModels,
} from '@footnote/contracts/providers';
import {
    imageRenderModels,
    imageTextModels,
} from '../src/commands/image/types.js';

type CommandOptionWithChoices = {
    choices?: Array<{ value: string }>;
};

const restoreProcessEnv = (originalEnv: NodeJS.ProcessEnv): void => {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key];
        }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
            continue;
        }

        process.env[key] = value;
    }
};

test('discord image model arrays match the shared registry', () => {
    assert.deepEqual(imageTextModels, internalImageTextModels);
    assert.deepEqual(imageRenderModels, internalImageRenderModels);
});

test('slash command choices match the shared registry', async () => {
    const originalEnv = { ...process.env };
    process.env.DISCORD_TOKEN = 'token';
    process.env.DISCORD_CLIENT_ID = 'client-id';
    process.env.DISCORD_GUILD_ID = 'guild-id';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.DISCORD_USER_ID = 'user-id';
    process.env.INCIDENT_PSEUDONYMIZATION_SECRET = 'secret';

    try {
        const moduleUrl = new URL('../src/commands/image.ts', import.meta.url);
        moduleUrl.searchParams.set('test', String(Date.now()));
        const { default: imageCommand } = (await import(
            moduleUrl.href
        )) as typeof import('../src/commands/image.js');
        const commandJson = imageCommand.data.toJSON();
        const imageModelOption = commandJson.options?.find(
            (option) => option.name === 'image_model'
        ) as CommandOptionWithChoices | undefined;
        const textModelOption = commandJson.options?.find(
            (option) => option.name === 'text_model'
        ) as CommandOptionWithChoices | undefined;

        assert.deepEqual(
            imageModelOption?.choices?.map((choice) => choice.value),
            [...internalImageRenderModels]
        );
        assert.deepEqual(
            textModelOption?.choices?.map((choice) => choice.value),
            [...internalImageTextModels]
        );
    } finally {
        restoreProcessEnv(originalEnv);
    }
});
