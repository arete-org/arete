/**
 * @description: Unit tests for shared reflect/traces runtime schemas in contracts.
 * @footnote-scope: test
 * @footnote-module: WebContractSchemasTests
 * @footnote-risk: low - Tests only validate schema behavior for known payload shapes.
 * @footnote-ethics: low - Uses synthetic metadata and no user-identifying data.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    ApiErrorResponseSchema,
    GetTraceApiResponseSchema,
    GetTraceStaleResponseSchema,
    PostReflectRequestSchema,
    PostReflectResponseSchema,
    PostTraceCardFromTraceRequestSchema,
    PostTraceCardFromTraceResponseSchema,
    PostTraceCardRequestSchema,
    PostTraceCardResponseSchema,
    PostTracesRequestSchema,
    ResponseMetadataSchema,
    createSchemaResponseValidator,
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
        PostReflectRequestSchema.safeParse({
            surface: 'web',
            trigger: { kind: 'submit' },
            latestUserInput: 'What is Footnote?',
            conversation: [
                {
                    role: 'user',
                    content: 'What is Footnote?',
                },
            ],
        }).success,
        true
    );

    assert.equal(
        PostReflectRequestSchema.safeParse({
            surface: 'web',
            trigger: { kind: 'submit' },
            latestUserInput: 'What is Footnote?',
            conversation: [
                {
                    role: 'user',
                    content: 'What is Footnote?',
                },
            ],
            extra: true,
        }).success,
        false
    );

    assert.equal(
        PostReflectRequestSchema.safeParse({
            surface: 'web',
            trigger: { kind: 'submit' },
            latestUserInput: 'x'.repeat(3073),
            conversation: [
                {
                    role: 'user',
                    content: 'What is Footnote?',
                },
            ],
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

test('ResponseMetadataSchema accepts valid TRACE temperament metadata', () => {
    const parsed = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        temperament: {
            tightness: 9,
            rationale: 6,
            attribution: 8,
            caution: 6,
            extent: 7,
        },
    });

    assert.equal(parsed.success, true);
});

test('ResponseMetadataSchema rejects invalid TRACE temperament metadata', () => {
    const parsed = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        temperament: {
            tightness: 11,
            rationale: 6,
            attribution: 8,
            caution: 6,
            extent: 7,
        },
    });

    assert.equal(parsed.success, false);
});

test('PostTracesRequestSchema rejects unknown request keys', () => {
    const parsed = PostTracesRequestSchema.safeParse({
        ...baseMetadata,
        extra: 'should-fail',
    });

    assert.equal(parsed.success, false);
});

test('PostTraceCardRequestSchema accepts valid trace-card payloads', () => {
    const parsed = PostTraceCardRequestSchema.safeParse({
        temperament: {
            tightness: 9,
            rationale: 6,
            attribution: 8,
            caution: 6,
            extent: 7,
        },
        chips: {
            confidencePercent: 88,
            riskTier: 'Medium',
            tradeoffCount: 2,
        },
    });

    assert.equal(parsed.success, true);
});

test('PostTraceCardRequestSchema rejects invalid chip values', () => {
    const parsed = PostTraceCardRequestSchema.safeParse({
        temperament: {
            tightness: 9,
            rationale: 6,
            attribution: 8,
            caution: 6,
            extent: 7,
        },
        chips: {
            confidencePercent: 101,
        },
    });

    assert.equal(parsed.success, false);
});

test('PostTraceCardResponseSchema requires responseId and pngBase64', () => {
    assert.equal(
        PostTraceCardResponseSchema.safeParse({
            responseId: 'trace-card-preview-1',
            pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        }).success,
        true
    );

    assert.equal(
        PostTraceCardResponseSchema.safeParse({
            responseId: 'trace-card-preview-1',
        }).success,
        false
    );
});

test('PostTraceCardFromTrace schemas require responseId and parse response envelope', () => {
    assert.equal(
        PostTraceCardFromTraceRequestSchema.safeParse({
            responseId: 'resp_trace_1',
        }).success,
        true
    );

    assert.equal(
        PostTraceCardFromTraceRequestSchema.safeParse({}).success,
        false
    );

    assert.equal(
        PostTraceCardFromTraceResponseSchema.safeParse({
            responseId: 'resp_trace_1',
            pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        }).success,
        true
    );
});

test('PostReflectResponseSchema and GetTraceStaleResponseSchema accept extensible responses', () => {
    const reflectParsed = PostReflectResponseSchema.safeParse({
        action: 'message',
        message: 'Hello',
        modality: 'text',
        metadata: {
            ...baseMetadata,
            additionalMetadata: true,
        },
        extraTopLevel: 'new-field',
    });
    assert.equal(reflectParsed.success, true);

    const imageParsed = PostReflectResponseSchema.safeParse({
        action: 'image',
        imageRequest: {
            prompt: 'a thoughtful robot reading under a tree',
            allowPromptAdjustment: false,
        },
        metadata: null,
        extraTopLevel: 'future-field',
    });
    assert.equal(imageParsed.success, true);

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

test('GetTraceApiResponseSchema accepts both live and stale trace payloads', () => {
    assert.equal(GetTraceApiResponseSchema.safeParse(baseMetadata).success, true);

    assert.equal(
        GetTraceApiResponseSchema.safeParse({
            message: 'Trace is stale',
            metadata: baseMetadata,
        }).success,
        true
    );
});

test('createSchemaResponseValidator returns normalized validation results', () => {
    const validateTraceResponse = createSchemaResponseValidator(
        GetTraceApiResponseSchema
    );

    const success = validateTraceResponse(baseMetadata);
    assert.equal(success.success, true);

    const failure = validateTraceResponse({ invalid: true });
    assert.equal(failure.success, false);
    if (!failure.success) {
        assert.match(failure.error, /body|responseId|metadata|provenance/i);
    }
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

