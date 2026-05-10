/**
 * @description: Verifies Langfuse shadow observability runtime config parsing and safe defaults.
 * @footnote-scope: test
 * @footnote-module: BackendLangfuseShadowConfigTests
 * @footnote-risk: low - Misparsed values here only affect optional maintainer observability.
 * @footnote-ethics: medium - Correct defaults reduce accidental external metadata export.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeConfig } from '../src/config/buildRuntimeConfig.js';

test('langfuse shadow config defaults to disabled with empty credentials', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig({}, (message) => warnings.push(message));

    assert.equal(config.langfuseShadow.enabled, false);
    assert.equal(config.langfuseShadow.baseUrl, null);
    assert.equal(config.langfuseShadow.publicKey, null);
    assert.equal(config.langfuseShadow.secretKey, null);
    assert.equal(config.langfuseShadow.timeoutMs, 1500);
});

test('langfuse shadow config parses explicit values', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig(
        {
            LANGFUSE_SHADOW_ENABLED: 'true',
            LANGFUSE_SHADOW_BASE_URL: 'https://cloud.langfuse.com',
            LANGFUSE_SHADOW_PUBLIC_KEY: 'pk-test',
            LANGFUSE_SHADOW_SECRET_KEY: 'sk-test',
            LANGFUSE_SHADOW_TIMEOUT_MS: '2100',
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.langfuseShadow.enabled, true);
    assert.equal(config.langfuseShadow.baseUrl, 'https://cloud.langfuse.com');
    assert.equal(config.langfuseShadow.publicKey, 'pk-test');
    assert.equal(config.langfuseShadow.secretKey, 'sk-test');
    assert.equal(config.langfuseShadow.timeoutMs, 2100);
});
