/**
 * @description: Verifies provenance interaction helpers resolve response IDs from CGI control custom IDs.
 * @footnote-scope: test
 * @footnote-module: ProvenanceInteractionTests
 * @footnote-risk: low - These tests validate ID extraction helpers only.
 * @footnote-ethics: medium - Correct ID extraction preserves trace lookup integrity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from 'discord.js';

import { buildProvenanceActionRow } from '../src/utils/response/provenanceCgi.js';
import { deriveResponseIdFromMessage } from '../src/utils/response/provenanceInteractions.js';

test('deriveResponseIdFromMessage recovers responseId from provenance CGI controls', () => {
    const message = {
        components: [buildProvenanceActionRow('resp_interactions_123')],
    } as unknown as Message;

    assert.equal(deriveResponseIdFromMessage(message), 'resp_interactions_123');
});

test('deriveResponseIdFromMessage returns null when no provenance controls are present', () => {
    const messageWithoutComponents = {
        components: [],
        embeds: [
            {
                footer: { text: 'legacy footer response id format' },
            },
        ],
    } as unknown as Message;

    assert.equal(deriveResponseIdFromMessage(messageWithoutComponents), null);
});

test('deriveResponseIdFromMessage tolerates malformed custom IDs', () => {
    const malformedMessage = {
        components: [
            {
                components: [
                    { customId: 'totally_invalid' },
                    { custom_id: 'details:' },
                    { data: { custom_id: 'report_issue' } },
                ],
            },
        ],
    } as unknown as Message;

    assert.equal(deriveResponseIdFromMessage(malformedMessage), null);
});

test('deriveResponseIdFromMessage returns first valid responseId across mixed rows', () => {
    const mixedRowsMessage = {
        components: [
            {
                components: [{ customId: 'malformed' }],
            },
            {
                components: [
                    { customId: 'details:resp_first_valid' },
                    { customId: 'report_issue:resp_second_valid' },
                ],
            },
        ],
    } as unknown as Message;

    assert.equal(
        deriveResponseIdFromMessage(mixedRowsMessage),
        'resp_first_valid'
    );
});

test('deriveResponseIdFromMessage parses nested data.custom_id payloads', () => {
    const nestedDataMessage = {
        components: [
            {
                components: [{ data: { custom_id: 'details:resp_nested' } }],
            },
        ],
    } as unknown as Message;

    assert.equal(deriveResponseIdFromMessage(nestedDataMessage), 'resp_nested');
});
