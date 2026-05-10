/**
 * @description: Verifies Langfuse metadata mirror runtime config parsing and safe defaults.
 * @footnote-scope: test
 * @footnote-module: BackendLangfuseMetadataMirrorConfigTests
 * @footnote-risk: low - Misparsed values here only affect optional maintainer observability.
 * @footnote-ethics: medium - Correct defaults reduce accidental external metadata export.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeConfig } from '../src/config/buildRuntimeConfig.js';

test('langfuse metadata mirror defaults to disabled with empty credentials', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig({}, (message) => warnings.push(message));

    assert.equal(config.langfuseMetadataMirror.enabled, false);
    assert.equal(config.langfuseMetadataMirror.baseUrl, null);
    assert.equal(config.langfuseMetadataMirror.publicKey, null);
    assert.equal(config.langfuseMetadataMirror.secretKey, null);
    assert.equal(config.langfuseMetadataMirror.timeoutMs, 1500);
});

test('langfuse metadata mirror parses explicit values', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig(
        {
            LANGFUSE_METADATA_MIRROR_ENABLED: 'true',
            LANGFUSE_METADATA_MIRROR_BASE_URL: 'https://cloud.langfuse.com',
            LANGFUSE_METADATA_MIRROR_PUBLIC_KEY: 'pk-test',
            LANGFUSE_METADATA_MIRROR_SECRET_KEY: 'sk-test',
            LANGFUSE_METADATA_MIRROR_TIMEOUT_MS: '2100',
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.langfuseMetadataMirror.enabled, true);
    assert.equal(
        config.langfuseMetadataMirror.baseUrl,
        'https://cloud.langfuse.com'
    );
    assert.equal(config.langfuseMetadataMirror.publicKey, 'pk-test');
    assert.equal(config.langfuseMetadataMirror.secretKey, 'sk-test');
    assert.equal(config.langfuseMetadataMirror.timeoutMs, 2100);
});

test('langfuse metadata mirror accepts legacy shadow env aliases', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig(
        {
            LANGFUSE_SHADOW_ENABLED: 'true',
            LANGFUSE_SHADOW_BASE_URL: 'https://cloud.langfuse.com',
            LANGFUSE_SHADOW_PUBLIC_KEY: 'pk-test',
            LANGFUSE_SHADOW_SECRET_KEY: 'sk-test',
            LANGFUSE_SHADOW_TIMEOUT_MS: '2200',
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.langfuseMetadataMirror.enabled, true);
    assert.equal(
        config.langfuseMetadataMirror.baseUrl,
        'https://cloud.langfuse.com'
    );
    assert.equal(config.langfuseMetadataMirror.publicKey, 'pk-test');
    assert.equal(config.langfuseMetadataMirror.secretKey, 'sk-test');
    assert.equal(config.langfuseMetadataMirror.timeoutMs, 2200);
});
