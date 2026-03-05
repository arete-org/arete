/**
 * @description: Verifies TRACE CGI provenance controls, custom ID parsing, and chip-score mapping.
 * @footnote-scope: test
 * @footnote-module: ProvenanceCgiTests
 * @footnote-risk: medium - Missing assertions could allow provenance control regressions and incorrect trace-card scoring.
 * @footnote-ethics: high - Provenance control integrity affects traceability and user trust.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import {
    buildProvenanceActionCustomId,
    buildProvenanceActionRow,
    buildTraceCardRequest,
    mapConfidenceToEvidenceScore,
    mapStaleAfterToFreshnessScore,
    parseProvenanceActionCustomId,
} from '../src/utils/response/provenanceCgi.js';

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

test('buildProvenanceActionRow renders details/report_issue with response-bound custom IDs', () => {
    const row = buildProvenanceActionRow('resp_123');
    const rowJson = row.toJSON() as { components: Array<{ custom_id?: string }> };
    const customIds = rowJson.components
        .map((component) => component.custom_id)
        .filter((value): value is string => typeof value === 'string');

    assert.equal(customIds.length, 2);
    assert.deepEqual(customIds, [
        'details:resp_123',
        'report_issue:resp_123',
    ]);
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
    assert.equal(parseProvenanceActionCustomId('alternative_lens:resp_1'), null);
    assert.equal(parseProvenanceActionCustomId('full_trace:resp_x'), null);
    assert.equal(parseProvenanceActionCustomId('report_issue'), null);
});

test('confidence maps to evidenceScore with clamping and fallback', () => {
    assert.equal(mapConfidenceToEvidenceScore(0), 1);
    assert.equal(mapConfidenceToEvidenceScore(0.5), 3);
    assert.equal(mapConfidenceToEvidenceScore(1), 5);
    assert.equal(mapConfidenceToEvidenceScore(-5), 1);
    assert.equal(mapConfidenceToEvidenceScore(2), 5);
    assert.equal(mapConfidenceToEvidenceScore(Number.NaN), 3);
});

test('staleAfter maps to freshnessScore with horizon decay and fallback', () => {
    const nowMs = 0;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const fresh = new Date(ninetyDaysMs).toISOString();
    const stale = new Date(0).toISOString();

    assert.equal(mapStaleAfterToFreshnessScore(fresh, nowMs), 5);
    assert.equal(mapStaleAfterToFreshnessScore(stale, nowMs), 1);
    assert.equal(mapStaleAfterToFreshnessScore('invalid-date', nowMs), 3);
});

test('buildTraceCardRequest uses neutral temperament fallback and mapped chip values', () => {
    const metadata = createMetadata();
    const request = buildTraceCardRequest(
        {
            ...metadata,
            confidence: Number.NaN,
            staleAfter: 'invalid-date',
            temperament: undefined,
        },
        0
    );

    assert.equal(request.responseId, 'resp_test_123');
    assert.deepEqual(request.temperament, {
        tightness: 5,
        rationale: 5,
        attribution: 5,
        caution: 5,
        extent: 5,
    });
    assert.equal(request.chips.evidenceScore, 3);
    assert.equal(request.chips.freshnessScore, 3);
});
