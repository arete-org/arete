/**
 * @description: Verifies profile-scoped mention alias resolution and plaintext matching behavior.
 * @footnote-scope: test
 * @footnote-module: MentionAliasesTests
 * @footnote-risk: low - These tests validate deterministic alias parsing and matching only.
 * @footnote-ethics: medium - Correct alias matching prevents spammy false positives and missed valid engagement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { BotProfileConfig } from '../src/config/profile.js';
import {
    containsPlaintextBotAlias,
    resolveBotMentionAliases,
} from '../src/utils/mentionAliases.js';

const createProfile = (
    overrides: Partial<BotProfileConfig> = {}
): BotProfileConfig => ({
    id: 'footnote',
    displayName: 'Footnote',
    mentionAliases: [],
    promptOverlay: {
        source: 'none',
        text: null,
        path: null,
        length: 0,
    },
    ...overrides,
});

test('resolveBotMentionAliases prefers explicit aliases and still keeps bot username', () => {
    const aliases = resolveBotMentionAliases(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
            mentionAliases: ['ari', 'support bot'],
        }),
        'AriRuntime'
    );

    assert.deepEqual(aliases, ['ari', 'support bot', 'ariruntime']);
});

test('resolveBotMentionAliases keeps the footnote alias for the default profile when explicit aliases are absent', () => {
    const aliases = resolveBotMentionAliases(
        createProfile({
            displayName: 'Ari',
        })
    );

    assert.deepEqual(aliases, ['footnote', 'ari']);
});

test('resolveBotMentionAliases does not inject the footnote alias for vendored profiles without explicit aliases', () => {
    const aliases = resolveBotMentionAliases(
        createProfile({
            id: 'ari-vendor',
            displayName: 'Ari',
        })
    );

    assert.deepEqual(aliases, ['ari']);
});

test('resolveBotMentionAliases dedupes normalized username and profile aliases', () => {
    const aliases = resolveBotMentionAliases(
        createProfile({
            displayName: 'Footnote',
            mentionAliases: ['Foot Note', 'foot  note'],
        }),
        'FOOT NOTE'
    );

    assert.deepEqual(aliases, ['foot note']);
});

test('containsPlaintextBotAlias matches whole words and blocks substring false positives', () => {
    assert.equal(containsPlaintextBotAlias('hey ari', ['ari']), true);
    assert.equal(containsPlaintextBotAlias('variable naming', ['ari']), false);
    assert.equal(containsPlaintextBotAlias('footnotebook setup', ['footnote']), false);
});

test('containsPlaintextBotAlias matches multi-word aliases with flexible whitespace', () => {
    assert.equal(
        containsPlaintextBotAlias('hey foot   note can you help?', ['foot note']),
        true
    );
});

test('containsPlaintextBotAlias is case-insensitive and returns false for blank content', () => {
    assert.equal(containsPlaintextBotAlias('HEY FOOTNOTE', ['footnote']), true);
    assert.equal(containsPlaintextBotAlias('   ', ['footnote']), false);
});

test('resolveBotMentionAliases ignores overlong aliases for regex safety', () => {
    const aliases = resolveBotMentionAliases(
        createProfile({
            displayName: 'Ari',
            mentionAliases: ['a'.repeat(101), 'ari'],
        })
    );

    assert.deepEqual(aliases, ['ari']);
});
