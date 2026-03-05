/**
 * @description: Verifies provenance interaction helpers resolve response IDs from CGI control custom IDs.
 * @footnote-scope: test
 * @footnote-module: ProvenanceInteractionTests
 * @footnote-risk: low - These tests validate ID extraction helpers only.
 * @footnote-ethics: medium - Correct ID extraction preserves trace lookup integrity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProvenanceActionRow } from '../src/utils/response/provenanceCgi.js';
import { deriveResponseIdFromMessage } from '../src/utils/response/provenanceInteractions.js';

test('deriveResponseIdFromMessage recovers responseId from provenance CGI controls', () => {
    const message = {
        components: [buildProvenanceActionRow('resp_interactions_123')],
    } as never;

    assert.equal(
        deriveResponseIdFromMessage(message),
        'resp_interactions_123'
    );
});

test('deriveResponseIdFromMessage returns null when no provenance controls are present', () => {
    const messageWithoutComponents = {
        components: [],
        embeds: [
            {
                footer: { text: 'legacy footer response id format' },
            },
        ],
    } as never;

    assert.equal(deriveResponseIdFromMessage(messageWithoutComponents), null);
});
