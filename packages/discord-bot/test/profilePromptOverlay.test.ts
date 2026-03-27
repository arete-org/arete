/**
 * @description: Verifies shared bot profile overlay prompt composition behavior.
 * @footnote-scope: test
 * @footnote-module: ProfilePromptOverlayTests
 * @footnote-risk: low - These tests validate deterministic prompt composition only.
 * @footnote-ethics: medium - Correct overlay composition preserves base safety constraints.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptRegistry } from '@footnote/prompts';

import {
    buildProfileOverlaySystemMessage,
    type ProfilePromptOverlayUsage,
} from '../src/config/profilePromptOverlay.js';
import {
    prependProfileOverlaySystemMessageToConversation,
    renderPromptLayersWithActivePersona,
} from '../src/config/promptComposition.js';
import type { BotProfileConfig } from '../src/config/profile.js';

const createProfile = (
    overrides: Partial<BotProfileConfig> = {}
): BotProfileConfig => ({
    id: 'ari-vendor',
    displayName: 'Ari',
    mentionAliases: [],
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
        'chat'
    );

    assert.equal(message, null);
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

test('buildProfileOverlaySystemMessage is deterministic for file-based overlays', () => {
    const profile = createProfile({
        promptOverlay: {
            source: 'file',
            text: 'Adopt the Ari vendor voice only when the configured profile requires it.',
            path: '/tmp/ari.txt',
            length: 72,
        },
    });

    const first = buildProfileOverlaySystemMessage(profile, 'provenance');
    const second = buildProfileOverlaySystemMessage(profile, 'provenance');

    assert.equal(first, second);
    assert.ok(first);
    assert.match(first, /Overlay Source: file/);
    assert.match(first, /Usage Context: provenance/);
});

test('renderPromptLayersWithActivePersona uses overlay as the active persona layer', () => {
    const registry = createPromptRegistry();
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

    assert.equal((prompt.match(/BEGIN Bot Profile Overlay/g) ?? []).length, 1);
    assert.match(
        prompt,
        /You are the image-generation orchestration system for a configured Discord bot profile\./
    );
    assert.match(prompt, /Usage Context: image\.system/);
    assert.doesNotMatch(
        prompt,
        /You are Footnote, the Discord voice of the Footnote project\./
    );
});

test('renderPromptLayersWithActivePersona falls back to default Footnote persona when no overlay exists', () => {
    const registry = createPromptRegistry();
    const prompt = renderPromptLayersWithActivePersona({
        registry,
        profile: createProfile({
            promptOverlay: {
                source: 'none',
                text: null,
                path: null,
                length: 0,
            },
        }),
        systemKeys: ['discord.image.system'],
        personaKeys: ['discord.image.persona.footnote'],
        usage: 'image.system',
        variables: {
            botProfileDisplayName: 'Footnote',
        },
    });

    assert.match(
        prompt,
        /You are Footnote, the Discord voice of the Footnote project\./
    );
    assert.doesNotMatch(prompt, /BEGIN Bot Profile Overlay/);
});

test('renderPromptLayersWithActivePersona supports shared and surface prompt layers', () => {
    const registry = createPromptRegistry();
    const prompt = renderPromptLayersWithActivePersona({
        registry,
        profile: createProfile({
            promptOverlay: {
                source: 'none',
                text: null,
                path: null,
                length: 0,
            },
        }),
        systemKeys: ['conversation.shared.system', 'discord.realtime.system'],
        personaKeys: [
            'conversation.shared.persona.footnote',
            'discord.realtime.persona.footnote',
        ],
        usage: 'realtime',
        variables: {
            botProfileDisplayName: 'Footnote',
        },
    });

    assert.match(
        prompt,
        /You are the response engine for a configured Footnote assistant\./
    );
    assert.match(prompt, /VOICE FORMAT/);
    assert.match(prompt, /You are Footnote, part of the Footnote project\./);
    assert.match(prompt, /In voice, keep your cadence steady/);
});

test('prependProfileOverlaySystemMessageToConversation preserves chat semantics', () => {
    const result = prependProfileOverlaySystemMessageToConversation(
        createProfile(),
        'chat',
        [{ role: 'user', content: 'hello' }]
    );

    assert.equal(result.overlayAdded, true);
    assert.equal(result.conversation[0].role, 'system');
    assert.match(result.conversation[0].content, /BEGIN Bot Profile Overlay/);
    assert.equal(result.conversation[1].content, 'hello');
});
