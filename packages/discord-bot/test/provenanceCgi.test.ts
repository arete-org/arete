/**
 * @description: Verifies TRACE CGI provenance controls, custom ID parsing, and metadata pass-through payload behavior.
 * @footnote-scope: test
 * @footnote-module: ProvenanceCgiTests
 * @footnote-risk: medium - Missing assertions could allow provenance control regressions and incorrect trace-card payload wiring.
 * @footnote-ethics: high - Provenance control integrity affects traceability and user trust.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import {
    buildProvenanceActionCustomId,
    buildProvenanceActionRow,
    buildTraceCardRequest,
    parseProvenanceActionCustomId,
} from '../src/utils/response/provenanceCgi.js';

function createMetadata(): ResponseMetadata {
    return {
        responseId: 'resp_test_123',
        provenance: 'Inferred',
        riskTier: 'Medium',
        tradeoffCount: 1,
        chainHash: 'abc123def456',
        licenseContext: 'MIT',
        modelVersion: 'gpt-5-mini',
        staleAfter: '2026-03-05T00:00:00.000Z',
        citations: [],
    };
}

test('buildProvenanceActionRow renders details/report_issue with response-bound custom IDs', () => {
    const row = buildProvenanceActionRow('resp_123');
    const rowJson = row.toJSON() as {
        components: Array<{ custom_id?: string }>;
    };
    const customIds = rowJson.components
        .map((component) => component.custom_id)
        .filter((value): value is string => typeof value === 'string');

    assert.equal(customIds.length, 2);
    assert.deepEqual(customIds, ['details:resp_123', 'report_issue:resp_123']);
    assert.equal(customIds.includes('details'), false);
    assert.equal(customIds.includes('report_issue'), false);
});

test('customId helpers round-trip valid provenance IDs', () => {
    const details = buildProvenanceActionCustomId('details', 'resp_a');
    const report = buildProvenanceActionCustomId('report_issue', 'resp_b');

    assert.deepEqual(parseProvenanceActionCustomId(details), {
        action: 'details',
        responseId: 'resp_a',
    });
    assert.deepEqual(parseProvenanceActionCustomId(report), {
        action: 'report_issue',
        responseId: 'resp_b',
    });
});

test('customId parser rejects invalid provenance IDs', () => {
    assert.equal(parseProvenanceActionCustomId('details'), null);
    assert.equal(parseProvenanceActionCustomId('details:'), null);
    assert.equal(
        parseProvenanceActionCustomId('alternative_lens:resp_1'),
        null
    );
    assert.equal(parseProvenanceActionCustomId('full_trace:resp_x'), null);
    assert.equal(parseProvenanceActionCustomId('report_issue'), null);
});

test('buildTraceCardRequest forwards metadata-provided TRACE values without defaults', () => {
    const metadata = createMetadata();
    const request = buildTraceCardRequest({
        ...metadata,
        temperament: {
            tightness: 5,
            attribution: 3,
        },
        evidenceScore: 4,
        freshnessScore: 2,
    });

    assert.equal(request.responseId, 'resp_test_123');
    assert.deepEqual(request.temperament, {
        tightness: 5,
        attribution: 3,
    });
    assert.deepEqual(request.chips, {
        evidenceScore: 4,
        freshnessScore: 2,
    });
});

test('buildTraceCardRequest omits invalid or missing TRACE values', () => {
    const metadata = createMetadata();
    const request = buildTraceCardRequest({
        ...metadata,
        responseId: '   ',
        temperament: {
            tightness: 6 as unknown as 5,
        },
        evidenceScore: 2.4 as unknown as 1,
        freshnessScore: 7 as unknown as 1,
    });

    assert.equal(request.responseId, 'unknown_response_id');
    assert.equal(request.temperament, undefined);
    assert.equal(request.chips, undefined);
});
