/**
 * @description: Verifies backend-owned image prompt composition preserves overlay and developer-prompt semantics.
 * @footnote-scope: test
 * @footnote-module: BackendImagePromptComposerTests
 * @footnote-risk: medium - Missing tests here could let backend prompt ownership drift from the previous Discord behavior.
 * @footnote-ethics: high - Prompt composition shapes identity, safety, and user-visible image behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { BotProfileConfig } from '../src/config/profile.js';
import { composeImagePrompts } from '../src/services/prompts/imagePromptComposer.js';

const createOverlayProfile = (): BotProfileConfig => ({
    id: 'ari-vendor',
    displayName: 'Ari',
    mentionAliases: [],
    promptOverlay: {
        source: 'inline',
        text: 'You may speak as Ari when this runtime is explicitly configured for that vendor.',
        path: null,
        length: 77,
    },
});

const createNoOverlayProfile = (): BotProfileConfig => ({
    id: 'footnote',
    displayName: 'Footnote',
    mentionAliases: [],
    promptOverlay: {
        source: 'none',
        text: null,
        path: null,
        length: 0,
    },
});

const createInput = () => ({
    prompt: 'A quiet library at dusk',
    allowPromptAdjustment: false,
    size: '1024x1024',
    quality: 'low',
    background: 'auto',
    style: 'natural',
    user: {
        username: 'Jordan',
        nickname: 'J',
        guildName: 'Footnote Lab',
    },
});

test('composeImagePrompts uses the overlay as the active image persona layer and keeps developer prompt core-only', () => {
    const prompts = composeImagePrompts(createInput(), createOverlayProfile());

    assert.match(prompts.systemPrompt, /BEGIN Bot Profile Overlay/);
    assert.match(prompts.systemPrompt, /Usage Context: image\.system/);
    assert.doesNotMatch(
        prompts.systemPrompt,
        /You are Ari, the Discord voice of the Footnote project\./
    );
    assert.match(
        prompts.developerPrompt,
        /You are orchestrating a Discord `\/image` command for Ari\./
    );
    assert.doesNotMatch(prompts.developerPrompt, /BEGIN Bot Profile Overlay/);
});

test('composeImagePrompts falls back to the default Footnote image persona when no overlay exists', () => {
    const prompts = composeImagePrompts(
        createInput(),
        createNoOverlayProfile()
    );

    assert.doesNotMatch(prompts.systemPrompt, /BEGIN Bot Profile Overlay/);
    assert.match(
        prompts.systemPrompt,
        /You are Footnote, the Discord voice of the Footnote project\./
    );
    assert.match(
        prompts.developerPrompt,
        /You are orchestrating a Discord `\/image` command for Footnote\./
    );
});
