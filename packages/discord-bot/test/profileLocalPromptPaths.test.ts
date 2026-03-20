/**
 * @description: Verifies remaining bot-local prompt paths apply profile overlay composition consistently.
 * @footnote-scope: test
 * @footnote-module: ProfileLocalPromptPathTests
 * @footnote-risk: low - These tests validate prompt construction only.
 * @footnote-ethics: high - Local prompt paths must preserve base safety while applying vendor overlays consistently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeConfig } from '../src/config.js';
import type { BotProfileConfig } from '../src/config/profile.js';
import { RealtimeContextBuilder } from '../src/utils/prompting/RealtimeContextBuilder.js';

const originalProfile = runtimeConfig.profile;

const withProfile = async (
    profile: BotProfileConfig,
    fn: () => Promise<void> | void
): Promise<void> => {
    const mutableRuntimeConfig = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    mutableRuntimeConfig.profile = profile;
    try {
        await fn();
    } finally {
        mutableRuntimeConfig.profile = originalProfile;
    }
};

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

test('RealtimeContextBuilder uses overlay as the active realtime persona layer', async () => {
    await withProfile(createOverlayProfile(), () => {
        const builder = new RealtimeContextBuilder();
        const result = builder.buildContext({
            participants: [{ id: 'u1', displayName: 'Jordan' }],
            transcripts: ['Earlier topic summary'],
        });

        assert.match(result.instructions, /BEGIN Bot Profile Overlay/);
        assert.match(result.instructions, /Usage Context: realtime/);
        assert.doesNotMatch(
            result.instructions,
            /You are Ari - the reasoning voice of the Footnote project\./
        );
        assert.match(
            result.instructions,
            /Participants currently in the voice channel/
        );
    });
});
