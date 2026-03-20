/**
 * @description: Unit tests for shared reflect/traces runtime schemas in contracts.
 * @footnote-scope: test
 * @footnote-module: WebContractSchemasTests
 * @footnote-risk: low - Tests only validate schema behavior for known payload shapes.
 * @footnote-ethics: low - Uses synthetic metadata and no user-identifying data.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ApiErrorResponseSchema,
    GetIncidentResponseSchema,
    GetIncidentsResponseSchema,
    InternalImageStreamEventSchema,
    PostInternalImageDescriptionTaskRequestSchema,
    PostInternalImageDescriptionTaskResponseSchema,
    PostInternalImageGenerateRequestSchema,
    PostInternalImageGenerateResponseSchema,
    PostInternalImageRequestSchema,
    PostInternalImageResponseSchema,
    PostInternalNewsTaskRequestSchema,
    PostInternalNewsTaskResponseSchema,
    PostInternalTextRequestSchema,
    PostInternalTextResponseSchema,
    GetTraceApiResponseSchema,
    GetTraceStaleResponseSchema,
    PostIncidentNotesRequestSchema,
    PostIncidentRemediationRequestSchema,
    PostIncidentReportRequestSchema,
    PostIncidentReportResponseSchema,
    PostIncidentStatusRequestSchema,
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
import {
    internalImageRenderModels,
    internalImageTextModels,
} from '../src/providers';
import type {
    GetIncidentResponse,
    GetIncidentsResponse,
    PostInternalImageGenerateResponse,
    PostInternalImageResponse,
    PostInternalNewsTaskResponse,
    PostInternalTextResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    PostIncidentReportResponse,
    PostReflectResponse,
} from '../src/web/types';
import type { ApiResponseValidationResult } from '../src/web/client-core';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const openApiSource = fs.readFileSync(
    path.join(repoRoot, 'docs/api/openapi.yaml'),
    'utf-8'
);

const baseMetadata = {
    responseId: 'response_123',
    provenance: 'Retrieved',
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

const baseIncidentDetail = {
    incident: {
        incidentId: '1a2b3c4d',
        status: 'new',
        tags: ['safety'],
        description: 'Reported response',
        contact: 'contact@example.com',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        consentedAt: new Date().toISOString(),
        pointers: {
            responseId: 'response_123',
            guildId: 'a'.repeat(64),
            channelId: 'b'.repeat(64),
            messageId: 'c'.repeat(64),
            modelVersion: 'gpt-5-mini',
            chainHash: 'hash_abc',
        },
        remediation: {
            state: 'pending',
            applied: false,
            notes: null,
            updatedAt: null,
        },
        auditEvents: [
            {
                action: 'incident.created',
                actorHash: 'd'.repeat(64),
                notes: 'created',
                createdAt: new Date().toISOString(),
            },
        ],
    },
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
            tightness: 5,
            rationale: 3,
            attribution: 4,
            caution: 3,
            extent: 4,
        },
    });

    assert.equal(parsed.success, true);
});

test('ResponseMetadataSchema accepts partial TRACE temperament metadata', () => {
    const parsed = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        temperament: {
            tightness: 5,
            attribution: 4,
        },
    });

    assert.equal(parsed.success, true);
});

test('ResponseMetadataSchema rejects invalid TRACE temperament metadata', () => {
    const parsed = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        temperament: {
            tightness: 6,
            rationale: 3,
            attribution: 4,
            caution: 3,
            extent: 4,
        },
    });

    assert.equal(parsed.success, false);
});

test('ResponseMetadataSchema accepts optional integer evidence/freshness scores', () => {
    const parsed = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        evidenceScore: 4,
        freshnessScore: 2,
    });

    assert.equal(parsed.success, true);
});

test('ResponseMetadataSchema rejects non-integer or out-of-range evidence/freshness scores', () => {
    const invalidDecimal = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        evidenceScore: 3.2,
    });
    assert.equal(invalidDecimal.success, false);

    const invalidRange = ResponseMetadataSchema.safeParse({
        ...baseMetadata,
        freshnessScore: 6,
    });
    assert.equal(invalidRange.success, false);
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
            tightness: 5,
            rationale: 3,
            attribution: 4,
            caution: 3,
            extent: 4,
        },
        chips: {
            evidenceScore: 4,
            freshnessScore: 5,
        },
    });

    assert.equal(parsed.success, true);
});

test('PostTraceCardRequestSchema rejects invalid chip values', () => {
    const parsed = PostTraceCardRequestSchema.safeParse({
        temperament: {
            tightness: 5,
            rationale: 3,
            attribution: 4,
            caution: 3,
            extent: 4,
        },
        chips: {
            evidenceScore: 6,
            freshnessScore: 2,
        },
    });

    assert.equal(parsed.success, false);
});

test('PostIncidentNotesRequestSchema rejects whitespace-only notes', () => {
    const parsed = PostIncidentNotesRequestSchema.safeParse({
        actorUserId: 'user_123',
        notes: '   ',
    });

    assert.equal(parsed.success, false);
});

test('PostIncidentReportRequestSchema rejects whitespace-only description and contact', () => {
    const parsed = PostIncidentReportRequestSchema.safeParse({
        reporterUserId: 'user_123',
        description: '   ',
        contact: '   ',
        consentedAt: new Date().toISOString(),
    });

    assert.equal(parsed.success, false);
});

test('PostTraceCardRequestSchema accepts missing chips and partial chip payloads', () => {
    const missingChips = PostTraceCardRequestSchema.safeParse({
        temperament: {
            tightness: 5,
            rationale: 3,
            attribution: 4,
            caution: 3,
            extent: 4,
        },
    });
    assert.equal(missingChips.success, true);

    const missingFreshness = PostTraceCardRequestSchema.safeParse({
        temperament: {
            tightness: 5,
            rationale: 3,
            attribution: 4,
            caution: 3,
            extent: 4,
        },
        chips: {
            evidenceScore: 3,
        },
    });
    assert.equal(missingFreshness.success, true);

    const scoreBelowRange = PostTraceCardRequestSchema.safeParse({
        temperament: {
            tightness: 5,
            rationale: 3,
            attribution: 4,
            caution: 3,
            extent: 4,
        },
        chips: {
            evidenceScore: 0.8,
            freshnessScore: 2,
        },
    });
    assert.equal(scoreBelowRange.success, false);

    const minimalPayload = PostTraceCardRequestSchema.safeParse({
        responseId: 'resp_minimal',
    });
    assert.equal(minimalPayload.success, true);
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
        PostTraceCardFromTraceRequestSchema.safeParse({
            responseId: 'resp_trace_1',
            chips: {
                evidenceScore: 2,
            },
        }).success,
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
    assert.equal(
        GetTraceApiResponseSchema.safeParse(baseMetadata).success,
        true
    );

    assert.equal(
        GetTraceApiResponseSchema.safeParse({
            message: 'Trace is stale',
            metadata: baseMetadata,
        }).success,
        true
    );
});

test('schema validator outputs stay assignable to shared response contract types', () => {
    const reflectValidator = createSchemaResponseValidator(
        PostReflectResponseSchema
    );
    const traceValidator = createSchemaResponseValidator(
        GetTraceApiResponseSchema
    );

    const typedReflectValidator: (
        data: unknown
    ) => ApiResponseValidationResult<PostReflectResponse> = reflectValidator;
    const typedTraceValidator: (
        data: unknown
    ) => ApiResponseValidationResult<GetTraceResponse | GetTraceStaleResponse> =
        traceValidator;

    assert.equal(typeof typedReflectValidator, 'function');
    assert.equal(typeof typedTraceValidator, 'function');
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

test('incident schemas accept valid request and response payloads', () => {
    const { auditEvents, ...incidentSummary } = baseIncidentDetail.incident;

    assert.equal(
        PostIncidentReportRequestSchema.safeParse({
            reporterUserId: '123456789012345678',
            guildId: '234567890123456789',
            channelId: '345678901234567890',
            messageId: '456789012345678901',
            jumpUrl: 'https://discord.com/channels/1/2/3',
            responseId: 'response_123',
            chainHash: 'hash_abc',
            modelVersion: 'gpt-5-mini',
            tags: ['safety', 'review'],
            description: 'Needs review',
            contact: 'contact@example.com',
            consentedAt: new Date().toISOString(),
        }).success,
        true
    );

    assert.equal(
        PostIncidentReportResponseSchema.safeParse({
            ...baseIncidentDetail,
            remediation: { state: 'pending' },
        }).success,
        true
    );

    assert.equal(
        GetIncidentsResponseSchema.safeParse({
            incidents: [incidentSummary],
        }).success,
        true
    );

    assert.equal(
        GetIncidentResponseSchema.safeParse(baseIncidentDetail).success,
        true
    );
});

test('incident mutating request schemas enforce strict payload rules', () => {
    assert.equal(
        PostIncidentStatusRequestSchema.safeParse({
            status: 'under_review',
            actorUserId: '123456789012345678',
            notes: 'taking a look',
        }).success,
        true
    );

    assert.equal(
        PostIncidentNotesRequestSchema.safeParse({
            actorUserId: '123456789012345678',
            notes: 'internal note',
        }).success,
        true
    );

    assert.equal(
        PostIncidentRemediationRequestSchema.safeParse({
            actorUserId: '123456789012345678',
            state: 'applied',
            notes: 'warning banner applied',
        }).success,
        true
    );

    assert.equal(
        PostIncidentRemediationRequestSchema.safeParse({
            state: 'pending',
        }).success,
        false
    );
});

test('incident schema validators stay assignable to shared contract types', () => {
    const incidentReportValidator = createSchemaResponseValidator(
        PostIncidentReportResponseSchema
    );
    const incidentsValidator = createSchemaResponseValidator(
        GetIncidentsResponseSchema
    );
    const incidentValidator = createSchemaResponseValidator(
        GetIncidentResponseSchema
    );

    const typedReportValidator: (
        data: unknown
    ) => ApiResponseValidationResult<PostIncidentReportResponse> =
        incidentReportValidator;
    const typedIncidentsValidator: (
        data: unknown
    ) => ApiResponseValidationResult<GetIncidentsResponse> = incidentsValidator;
    const typedIncidentValidator: (
        data: unknown
    ) => ApiResponseValidationResult<GetIncidentResponse> = incidentValidator;

    assert.equal(typeof typedReportValidator, 'function');
    assert.equal(typeof typedIncidentsValidator, 'function');
    assert.equal(typeof typedIncidentValidator, 'function');
});

test('internal text task schemas enforce a narrow task union', () => {
    assert.equal(
        PostInternalNewsTaskRequestSchema.safeParse({
            task: 'news',
            query: 'latest ai policy',
            category: 'tech',
            maxResults: 3,
            reasoningEffort: 'medium',
            verbosity: 'medium',
            channelContext: {
                channelId: '123',
                guildId: '456',
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalTextRequestSchema.safeParse({
            task: 'news',
            query: 'latest ai policy',
            category: 'tech',
            maxResults: 3,
            reasoningEffort: 'medium',
            verbosity: 'medium',
            channelContext: {
                channelId: '123',
                guildId: '456',
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalImageDescriptionTaskRequestSchema.safeParse({
            task: 'image_description',
            imageUrl: 'https://example.com/screenshot.png',
            context: 'User asked what changed in this screenshot.',
            channelContext: {
                channelId: '123',
                guildId: '456',
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalTextRequestSchema.safeParse({
            task: 'image_description',
            imageUrl: 'https://example.com/screenshot.png',
        }).success,
        true
    );

    assert.equal(
        PostInternalNewsTaskRequestSchema.safeParse({
            task: 'news',
            maxResults: 6,
        }).success,
        false
    );

    assert.equal(
        PostInternalImageDescriptionTaskRequestSchema.safeParse({
            task: 'image_description',
            imageUrl: 'not-a-url',
        }).success,
        false
    );

    assert.equal(
        PostInternalTextRequestSchema.safeParse({
            task: 'basic',
            prompt: 'hello',
        }).success,
        false
    );

    assert.equal(
        PostInternalNewsTaskResponseSchema.safeParse({
            task: 'news',
            result: {
                news: [
                    {
                        title: 'Policy update',
                        summary: 'A short summary',
                        url: 'https://example.com/news',
                        source: 'Example News',
                        timestamp: new Date().toISOString(),
                    },
                ],
                summary: 'One headline matters today.',
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalNewsTaskResponseSchema.safeParse({
            task: 'news',
            result: {
                news: [
                    {
                        title: 'Policy update',
                        summary: 'A short summary',
                        url: 'https://example.com/news',
                        source: 'Example News',
                    },
                ],
                summary: 'One headline matters today.',
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalImageDescriptionTaskResponseSchema.safeParse({
            task: 'image_description',
            result: {
                description: '{"summary":"Screenshot of a policy update"}',
                model: 'gpt-4o-mini',
                usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    totalTokens: 15,
                },
                costs: {
                    input: 0.0000015,
                    output: 0.000003,
                    total: 0.0000045,
                },
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalTextResponseSchema.safeParse({
            task: 'news',
            result: {
                news: [
                    {
                        title: 'Policy update',
                        summary: 'A short summary',
                        url: 'https://example.com/news',
                        source: 'Example News',
                        timestamp: new Date().toISOString(),
                    },
                ],
                summary: 'One headline matters today.',
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalTextResponseSchema.safeParse({
            task: 'news',
            result: {
                news: [
                    {
                        title: 'Policy update',
                        summary: 'A short summary',
                        url: 'https://example.com/news',
                        source: 'Example News',
                    },
                ],
                summary: 'One headline matters today.',
            },
        }).success,
        true
    );

    assert.equal(
        PostInternalTextResponseSchema.safeParse({
            task: 'image_description',
            result: {
                description: '{"summary":"Screenshot of a policy update"}',
                model: 'gpt-4o-mini',
                usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    totalTokens: 15,
                },
                costs: {
                    input: 0.0000015,
                    output: 0.000003,
                    total: 0.0000045,
                },
            },
        }).success,
        true
    );
});

test('internal text schema validator stays assignable to shared contract types', () => {
    const validator = createSchemaResponseValidator(
        PostInternalNewsTaskResponseSchema
    );
    const endpointValidator = createSchemaResponseValidator(
        PostInternalTextResponseSchema
    );
    const typedValidator: (
        data: unknown
    ) => ApiResponseValidationResult<PostInternalNewsTaskResponse> = validator;
    const typedEndpointValidator: (
        data: unknown
    ) => ApiResponseValidationResult<PostInternalTextResponse> =
        endpointValidator;

    assert.equal(typeof typedValidator, 'function');
    assert.equal(typeof typedEndpointValidator, 'function');
});

test('internal image task schemas enforce a narrow generate-only task union', () => {
    const requestPayload = {
        task: 'generate',
        prompt: 'draw a reflective skyline',
        textModel: 'gpt-5-mini',
        imageModel: 'gpt-image-1-mini',
        size: '1024x1024',
        quality: 'medium',
        background: 'auto',
        style: 'vivid',
        allowPromptAdjustment: true,
        outputFormat: 'png',
        outputCompression: 100,
        user: {
            username: 'Jordan',
            nickname: 'Jordan',
            guildName: 'Footnote Lab',
        },
        followUpResponseId: 'resp_prev_123',
        channelContext: {
            channelId: '123',
            guildId: '456',
        },
        stream: true,
    } as const;

    assert.equal(
        PostInternalImageGenerateRequestSchema.safeParse(requestPayload)
            .success,
        true
    );
    assert.equal(
        PostInternalImageRequestSchema.safeParse(requestPayload).success,
        true
    );

    assert.equal(
        PostInternalImageGenerateRequestSchema.safeParse({
            ...requestPayload,
            outputCompression: 101,
        }).success,
        false
    );
    assert.equal(
        PostInternalImageRequestSchema.safeParse({
            task: 'render',
            prompt: 'hello',
        }).success,
        false
    );

    const responsePayload = {
        task: 'generate',
        result: {
            responseId: 'resp_123',
            textModel: 'gpt-5-mini',
            imageModel: 'gpt-image-1-mini',
            revisedPrompt: 'draw a reflective skyline at dusk',
            finalStyle: 'vivid',
            annotations: {
                title: 'Reflective Skyline',
                description: 'A city scene at dusk.',
                note: 'The skyline emphasizes calm light.',
                adjustedPrompt: 'draw a reflective skyline at dusk',
            },
            finalImageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
            outputFormat: 'png',
            outputCompression: 100,
            usage: {
                inputTokens: 42,
                outputTokens: 18,
                totalTokens: 60,
                imageCount: 1,
            },
            costs: {
                text: 0.000046,
                image: 0.011,
                total: 0.011046,
                perImage: 0.011,
            },
            generationTimeMs: 2100,
        },
    } as const;

    assert.equal(
        PostInternalImageGenerateResponseSchema.safeParse(responsePayload)
            .success,
        true
    );
    assert.equal(
        PostInternalImageResponseSchema.safeParse(responsePayload).success,
        true
    );
    assert.equal(
        InternalImageStreamEventSchema.safeParse({
            type: 'partial_image',
            index: 0,
            base64: 'aGVsbG8=',
        }).success,
        true
    );
    assert.equal(
        InternalImageStreamEventSchema.safeParse({
            type: 'result',
            task: 'generate',
            result: responsePayload.result,
        }).success,
        true
    );
    assert.equal(
        InternalImageStreamEventSchema.safeParse({
            type: 'error',
            error: 'Failed to execute internal image task',
        }).success,
        true
    );
});

test('internal image schema enums stay aligned with the shared model registry', () => {
    const requestTextOptions =
        PostInternalImageGenerateRequestSchema.shape.textModel.options;
    const requestImageOptions =
        PostInternalImageGenerateRequestSchema.shape.imageModel.options;
    const responseTextOptions =
        PostInternalImageGenerateResponseSchema.shape.result.shape.textModel
            .options;
    const responseImageOptions =
        PostInternalImageGenerateResponseSchema.shape.result.shape.imageModel
            .options;

    assert.deepEqual(requestTextOptions, [...internalImageTextModels]);
    assert.deepEqual(requestImageOptions, [...internalImageRenderModels]);
    assert.deepEqual(responseTextOptions, [...internalImageTextModels]);
    assert.deepEqual(responseImageOptions, [...internalImageRenderModels]);
});

test('openapi internal image enums stay aligned with the shared model registry', () => {
    const normalizedOpenApiSource = openApiSource.replace(/\s+/g, ' ');
    const buildEnumPattern = (values: readonly string[]) =>
        `enum:\\s*\\[\\s*${values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(',\\s*')}\\s*,?\\s*\\]`;

    const textEnumMatches = normalizedOpenApiSource.match(
        new RegExp(buildEnumPattern(internalImageTextModels), 'g')
    );
    const imageEnumMatches = normalizedOpenApiSource.match(
        new RegExp(buildEnumPattern(internalImageRenderModels), 'g')
    );

    assert.ok((textEnumMatches?.length ?? 0) >= 2);
    assert.ok((imageEnumMatches?.length ?? 0) >= 2);
});

test('internal image schema validator stays assignable to shared contract types', () => {
    const validator = createSchemaResponseValidator(
        PostInternalImageGenerateResponseSchema
    );
    const endpointValidator = createSchemaResponseValidator(
        PostInternalImageResponseSchema
    );
    const typedValidator: (
        data: unknown
    ) => ApiResponseValidationResult<PostInternalImageGenerateResponse> =
        validator;
    const typedEndpointValidator: (
        data: unknown
    ) => ApiResponseValidationResult<PostInternalImageResponse> =
        endpointValidator;

    assert.equal(typeof typedValidator, 'function');
    assert.equal(typeof typedEndpointValidator, 'function');
});
