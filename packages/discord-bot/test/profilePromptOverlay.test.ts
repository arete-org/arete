/**
 * @description: Verifies shared bot profile overlay prompt composition behavior.
 * @footnote-scope: test
 * @footnote-module: ProfilePromptOverlayTests
 * @footnote-risk: low - These tests validate deterministic prompt composition only.
 * @footnote-ethics: medium - Correct overlay composition preserves base safety constraints.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildProfileOverlaySystemMessage,
    composePromptWithProfileOverlay,
    type ProfilePromptOverlayUsage,
} from '../src/config/profilePromptOverlay.js';
import type { BotProfileConfig } from '../src/config/profile.js';

const createProfile = (
    overrides: Partial<BotProfileConfig> = {}
): BotProfileConfig => ({
    id: 'ari-vendor',
    displayName: 'Ari',
    promptOverlay: {
        source: 'inline',
        text: 'You may speak as Ari when that identity is explicitly configured.',
        path: null,
        length: 62,
    },
    ...overrides,
});

test('buildProfileOverlaySystemMessage returns null when no overlay text exists', () => {
    const message = buildProfileOverlaySystemMessage(
        createProfile({
            promptOverlay: {
                source: 'none',
                text: null,
                path: null,
                length: 0,
            },
        }),
        'reflect'
    );

    assert.equal(message, null);
});

test('composePromptWithProfileOverlay leaves the base prompt unchanged when no overlay exists', () => {
    const basePrompt = 'You are Footnote.';
    const result = composePromptWithProfileOverlay(
        basePrompt,
        createProfile({
            promptOverlay: {
                source: 'none',
                text: null,
                path: null,
                length: 0,
            },
        }),
        'reflect'
    );

    assert.equal(result, basePrompt);
});

test('buildProfileOverlaySystemMessage includes metadata, guardrail, and overlay body', () => {
    const usage: ProfilePromptOverlayUsage = 'realtime';
    const message = buildProfileOverlaySystemMessage(createProfile(), usage);

    assert.ok(message);
    assert.match(message, /BEGIN Bot Profile Overlay/);
    assert.match(message, /Profile ID: ari-vendor/);
    assert.match(message, /Profile Display Name: Ari/);
    assert.match(message, /Overlay Source: inline/);
    assert.match(message, /Usage Context: realtime/);
    assert.match(
        message,
        /Base Footnote safety, provenance, and system constraints take precedence/
    );
    assert.match(
        message,
        /You may speak as Ari when that identity is explicitly configured\./
    );
});

test('composePromptWithProfileOverlay appends the overlay block exactly once', () => {
    const result = composePromptWithProfileOverlay(
        'You are Footnote.\nStay grounded.',
        createProfile(),
        'image.system'
    );

    assert.equal((result.match(/BEGIN Bot Profile Overlay/g) ?? []).length, 1);
    assert.equal(
        result.startsWith('You are Footnote.\nStay grounded.\n\n// =========='),
        true
    );
});

test('composePromptWithProfileOverlay is deterministic for file-based overlays', () => {
    const profile = createProfile({
        promptOverlay: {
            source: 'file',
            text: 'Adopt the Ari vendor voice only when the configured profile requires it.',
            path: '/tmp/ari.txt',
            length: 72,
        },
    });

    const first = composePromptWithProfileOverlay(
        'Base prompt.',
        profile,
        'provenance'
    );
    const second = composePromptWithProfileOverlay(
        'Base prompt.',
        profile,
        'provenance'
    );

    assert.equal(first, second);
    assert.match(first, /Overlay Source: file/);
    assert.match(first, /Usage Context: provenance/);
});
