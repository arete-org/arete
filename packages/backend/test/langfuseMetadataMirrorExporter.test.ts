/**
 * @description: Verifies Langfuse metadata mirror exporter behavior for disablement, safe payload shaping, and fail-open errors.
 * @footnote-scope: test
 * @footnote-module: LangfuseMetadataMirrorExporterTests
 * @footnote-risk: low - Test gaps only affect optional metadata mirror observability confidence.
 * @footnote-ethics: medium - Confirms we avoid exporting raw response content in mirrored payloads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResponseMetadata } from '@footnote/contracts/policy';
import { createLangfuseMetadataMirrorExporter } from '../src/services/langfuseMetadataMirrorExporter.js';

const createMetadata = (
    overrides: Partial<ResponseMetadata> = {}
): ResponseMetadata => ({
    responseId: 'metadata_mirror_response_123',
    provenance: 'Retrieved',
    safetyTier: 'Low',
    tradeoffCount: 1,
    chainHash: 'chain_hash',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
    trace_target: {},
    trace_final: {},
    ...overrides,
});

test('langfuse metadata mirror exporter is a no-op when disabled', async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error('unexpected fetch call');
    }) as typeof fetch;

    try {
        const exporter = createLangfuseMetadataMirrorExporter({
            enabled: false,
            baseUrl: null,
            publicKey: null,
            secretKey: null,
            timeoutMs: 1500,
        });
        await exporter(createMetadata());
        assert.equal(fetchCalled, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('langfuse metadata mirror exporter posts metadata-only payload to ingestion endpoint', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    let capturedAuth = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ) => {
        capturedUrl = String(input);
        capturedBody = String(init?.body ?? '');
        capturedAuth = String(
            init?.headers
                ? (init.headers as Record<string, string>).Authorization
                : ''
        );
        return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    try {
        const exporter = createLangfuseMetadataMirrorExporter({
            enabled: true,
            baseUrl: 'https://cloud.langfuse.com',
            publicKey: 'pk-test',
            secretKey: 'sk-test',
            timeoutMs: 1500,
        });
        await exporter(
            createMetadata({
                modelInput: 'raw input should not be exported',
                modelResponse: 'raw output should not be exported',
            } as Partial<ResponseMetadata>)
        );

        assert.equal(
            capturedUrl,
            'https://cloud.langfuse.com/api/public/ingestion'
        );
        assert.match(capturedAuth, /^Basic /);
        assert.ok(capturedBody.length > 0);
        assert.equal(
            capturedBody.includes('raw input should not be exported'),
            false
        );
        assert.equal(
            capturedBody.includes('raw output should not be exported'),
            false
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('langfuse metadata mirror exporter throws on non-ok response so caller can fail-open', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        return { ok: false, status: 500 } as Response;
    }) as typeof fetch;

    try {
        const exporter = createLangfuseMetadataMirrorExporter({
            enabled: true,
            baseUrl: 'https://cloud.langfuse.com',
            publicKey: 'pk-test',
            secretKey: 'sk-test',
            timeoutMs: 1500,
        });
        await assert.rejects(exporter(createMetadata()), /status 500/i);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
