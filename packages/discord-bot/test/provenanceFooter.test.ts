/**
 * @description: Verifies provenance footer action buttons render the expected compact details/trace/report controls.
 * @footnote-scope: test
 * @footnote-module: ProvenanceFooterTests
 * @footnote-risk: low - These assertions validate UI component wiring only and do not affect runtime behavior directly.
 * @footnote-ethics: medium - Correct control labeling and ordering preserves transparency workflows users rely on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFooterEmbed } from '../src/utils/response/provenanceFooter.js';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';

type ActionRowButtonJson = {
    custom_id?: string;
};

type ActionRowJson = {
    components: ActionRowButtonJson[];
};

function createMetadata(): ResponseMetadata {
    return {
        responseId: 'resp_test_123',
        provenance: 'Inferred',
        confidence: 0.72,
        riskTier: 'Medium',
        tradeoffCount: 1,
        chainHash: 'abc123def456',
        licenseContext: 'MIT',
        modelVersion: 'gpt-5-mini',
        staleAfter: '2026-03-05T00:00:00.000Z',
        citations: [],
    };
}

test('buildFooterEmbed renders only details, full_trace, and report_issue buttons in order', () => {
    const payload = buildFooterEmbed(createMetadata(), 'https://example.com');
    assert.equal(payload.components.length, 1);

    const rowJson = payload.components[0].toJSON() as ActionRowJson;
    assert.equal(rowJson.components.length, 3);

    const customIds = rowJson.components
        .map((component) => component.custom_id)
        .filter((value): value is string => typeof value === 'string');

    assert.deepEqual(customIds, ['details', 'full_trace', 'report_issue']);
    assert.equal(customIds.includes('explain'), false);
    assert.equal(customIds.includes('alternative_lens'), false);
});
