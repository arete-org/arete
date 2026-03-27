/**
 * @description: Verifies backend cost recorder behavior for canonicalized model ids and unknown model warnings.
 * @footnote-scope: test
 * @footnote-module: BackendLLMCostRecorderTests
 * @footnote-risk: medium - Missing tests could let unpriced-model warnings regress and silently weaken cost visibility.
 * @footnote-ethics: medium - These checks preserve transparent cost reporting and clear warning metadata.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBackendTextCost } from '../src/services/llmCostRecorder.js';
import { logger } from '../src/utils/logger.js';

test('estimateBackendTextCost does not warn for known versioned OpenAI model ids', () => {
    const warnings: string[] = [];
    const originalWarn = logger.warn.bind(logger);
    logger.warn = (message: unknown) => {
        warnings.push(String(message));
        return logger;
    };

    try {
        const cost = estimateBackendTextCost(
            'openai/gpt-5-mini/2026-03-27',
            120,
            80
        );

        assert.equal(cost.inputCostUsd, 0.00003);
        assert.equal(cost.outputCostUsd, 0.00016);
        assert.equal(cost.totalCostUsd, 0.00019);
        assert.equal(warnings.length, 0);
    } finally {
        logger.warn = originalWarn;
    }
});

test('estimateBackendTextCost warns with canonicalization outcome for unknown ids', () => {
    const warnings: string[] = [];
    const originalWarn = logger.warn.bind(logger);
    logger.warn = (message: unknown) => {
        warnings.push(String(message));
        return logger;
    };

    try {
        const cost = estimateBackendTextCost(
            'openai/gpt-unknown/2026-03-27',
            120,
            80
        );

        assert.equal(cost.inputCostUsd, 0);
        assert.equal(cost.outputCostUsd, 0);
        assert.equal(cost.totalCostUsd, 0);
        assert.equal(warnings.length, 1);

        const payload = JSON.parse(warnings[0] ?? '{}') as {
            event?: string;
            pricingKind?: string;
            model?: string;
            canonicalModel?: string;
            wasCanonicalized?: boolean;
            appliedRules?: unknown;
        };
        assert.equal(payload.event, 'backend_unpriced_model');
        assert.equal(payload.pricingKind, 'text');
        assert.equal(payload.model, 'openai/gpt-unknown/2026-03-27');
        assert.equal(payload.canonicalModel, 'gpt-unknown');
        assert.equal(payload.wasCanonicalized, true);
        assert.deepEqual(payload.appliedRules, [
            'remove_openai_prefix',
            'strip_slash_date_suffix',
        ]);
    } finally {
        logger.warn = originalWarn;
    }
});
