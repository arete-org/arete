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

import { botApi } from '../src/api/botApi.js';
import { buildProvenanceActionRow } from '../src/utils/response/provenanceCgi.js';
import {
    deriveResponseIdFromMessage,
    resolveProvenanceMetadata,
} from '../src/utils/response/provenanceInteractions.js';

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

test('resolveProvenanceMetadata rejects mismatched trace payload response IDs', async () => {
    const originalGetTrace = botApi.getTrace;
    (botApi as { getTrace: typeof botApi.getTrace }).getTrace = async () =>
        ({
            status: 200,
            data: {
                responseId: 'resp_other',
                provenance: 'Retrieved',
                riskTier: 'Low',
                tradeoffCount: 1,
                chainHash: 'hash_123',
                licenseContext: 'MIT',
                modelVersion: 'gpt-5-mini',
                staleAfter: new Date().toISOString(),
                citations: [],
            },
        }) as Awaited<ReturnType<typeof botApi.getTrace>>;

    try {
        const message = {
            components: [buildProvenanceActionRow('resp_expected')],
        } as unknown as Message;

        const result = await resolveProvenanceMetadata(message);

        assert.equal(result.responseId, 'resp_expected');
        assert.equal(result.metadata, null);
    } finally {
        (botApi as { getTrace: typeof botApi.getTrace }).getTrace =
            originalGetTrace;
    }
});
