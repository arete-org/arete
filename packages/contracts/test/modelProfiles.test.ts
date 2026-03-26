/**
 * @description: Validates model profile catalog schema constraints.
 * @footnote-scope: test
 * @footnote-module: ModelProfileContractsTests
 * @footnote-risk: medium - Weak schema checks could allow ambiguous routing config into runtime.
 * @footnote-ethics: medium - Catalog validation quality affects policy/capability guarantees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProfileCatalogSchema } from '../src/model-profiles.js';

test('ModelProfileCatalogSchema rejects duplicate profile ids with a clear error', () => {
    const parsed = ModelProfileCatalogSchema.safeParse([
        {
            id: 'openai-text-fast',
            description: 'Fast profile',
            provider: 'openai',
            providerModel: 'gpt-5-mini',
            enabled: true,
            tierBindings: ['text-fast'],
            capabilities: { canUseSearch: true },
        },
        {
            id: 'openai-text-fast',
            description: 'Duplicate id profile',
            provider: 'openai',
            providerModel: 'gpt-5',
            enabled: true,
            tierBindings: ['text-quality'],
            capabilities: { canUseSearch: true },
        },
    ]);

    assert.equal(parsed.success, false);
    if (parsed.success) {
        return;
    }

    const message = parsed.error.issues.map((issue) => issue.message).join('\n');
    assert.match(message, /Duplicate model profile id\(s\): openai-text-fast/);
});
