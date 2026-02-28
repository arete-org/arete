/**
 * @description: Verifies trace metadata runtime validation behavior in shared store helpers.
 * @arete-scope: test
 * @arete-module: TraceStoreUtilsValidationTests
 * @arete-risk: low - Test-only coverage for validation edge cases.
 * @arete-ethics: low - Uses synthetic metadata payloads only.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import { assertValidResponseMetadata } from '../src/storage/traces/traceStoreUtils.js';

const baseMetadata = {
    responseId: 'response_123',
    provenance: 'Retrieved',
    confidence: 0.85,
    riskTier: 'Low',
    tradeoffCount: 2,
    chainHash: 'chain_hash',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5',
    staleAfter: new Date().toISOString(),
    citations: [
        {
            title: 'Example source',
            url: 'https://example.com/source',
        },
    ],
};

test('assertValidResponseMetadata accepts valid metadata with forward-compatible fields', () => {
    const payload = {
        ...baseMetadata,
        futureField: { enabled: true },
    };

    assert.doesNotThrow(() =>
        assertValidResponseMetadata(
            payload,
            'traceStoreUtilsValidation.test',
            payload.responseId
        )
    );
});

test('assertValidResponseMetadata rejects invalid citation URLs', () => {
    const payload = {
        ...baseMetadata,
        citations: [
            {
                title: 'Broken source',
                url: 'not-a-url',
            },
        ],
    };

    assert.throws(
        () =>
            assertValidResponseMetadata(
                payload,
                'traceStoreUtilsValidation.test',
                payload.responseId
            ),
        /invalid/i
    );
});

test('assertValidResponseMetadata rejects missing responseId', () => {
    const payload = {
        ...baseMetadata,
    } as {
        responseId?: string;
    };
    delete payload.responseId;

    assert.throws(
        () =>
            assertValidResponseMetadata(
                payload,
                'traceStoreUtilsValidation.test',
                'missing_response_id'
            ),
        /responseId/i
    );
});
