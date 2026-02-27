/**
 * @description: Unit tests for shared reflect/traces runtime schemas in contracts.
 * @arete-scope: test
 * @arete-module: WebContractSchemasTests
 * @arete-risk: low - Tests only validate schema behavior for known payload shapes.
 * @arete-ethics: low - Uses synthetic metadata and no user-identifying data.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    ApiErrorResponseSchema,
    GetTraceStaleResponseSchema,
    PostReflectRequestSchema,
    PostReflectResponseSchema,
    PostTracesRequestSchema,
    ResponseMetadataSchema,
} from '../src/web/schemas';

const baseMetadata = {
    responseId: 'response_123',
    provenance: 'Retrieved',
    confidence: 0.85,
    riskTier: 'Low',
    tradeoffCount: 2,
    chainHash: 'hash_abc',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5',
    staleAfter: new Date().toISOString(),
    citations: [
        {
            title: 'Example source',
            url: 'https://example.com/article',
        },
    ],
} as const;

test('PostReflectRequestSchema enforces strict request payload rules', () => {
    assert.equal(
        PostReflectRequestSchema.safeParse({ question: 'What is ARETE?' })
            .success,
        true
    );

    assert.equal(
        PostReflectRequestSchema.safeParse({
            question: 'What is ARETE?',
            extra: true,
        }).success,
        false
    );

    assert.equal(
        PostReflectRequestSchema.safeParse({
            question: 'x'.repeat(3073),
        }).success,
        false
    );
});

test('ResponseMetadataSchema remains tolerant for forward-compatible responses', () => {
    const parsed = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        futureField: { source: 'future-backend' },
    });

    assert.equal(parsed.success, true);
});

test('PostTracesRequestSchema rejects unknown request keys', () => {
    const parsed = PostTracesRequestSchema.safeParse({
        ...baseMetadata,
        extra: 'should-fail',
    });

    assert.equal(parsed.success, false);
});

test('PostReflectResponseSchema and GetTraceStaleResponseSchema accept extensible responses', () => {
    const reflectParsed = PostReflectResponseSchema.safeParse({
        message: 'Hello',
        metadata: {
            ...baseMetadata,
            additionalMetadata: true,
        },
        extraTopLevel: 'new-field',
    });
    assert.equal(reflectParsed.success, true);

    const staleParsed = GetTraceStaleResponseSchema.safeParse({
        message: 'Trace is stale',
        metadata: {
            ...baseMetadata,
            archivalHint: 'cold-storage',
        },
        extraTopLevel: true,
    });
    assert.equal(staleParsed.success, true);
});

test('ApiErrorResponseSchema enforces strict known error envelope fields', () => {
    assert.equal(
        ApiErrorResponseSchema.safeParse({ error: 'Bad request' }).success,
        true
    );

    assert.equal(
        ApiErrorResponseSchema.safeParse({
            error: 'Bad request',
            unknown: 'unexpected-field',
        }).success,
        false
    );
});
