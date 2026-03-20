/**
 * @description: Validates the shared OpenAI pricing tables and pure estimation helpers.
 * @footnote-scope: test
 * @footnote-module: SharedPricingTests
 * @footnote-risk: medium - Missing tests here could let pricing drift across backend, runtime, and Discord displays.
 * @footnote-ethics: high - Shared pricing underpins transparent spend reporting across Footnote.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    estimateOpenAIImageGenerationCost,
    estimateOpenAITextCost,
    supportedPricedOpenAITextModels,
} from '../src/pricing.js';
import { supportedOpenAITextModels } from '../src/providers.js';

test('estimateOpenAITextCost matches the shared GPT-5 mini pricing table', () => {
    const result = estimateOpenAITextCost('gpt-5-mini', 120, 80);

    assert.equal(result.inputCost, 0.00003);
    assert.equal(result.outputCost, 0.00016);
    assert.equal(result.totalCost, 0.00019);
});

test('estimateOpenAITextCost fails open to zero for unknown model strings', () => {
    const result = estimateOpenAITextCost('future-model', 120, 80);

    assert.equal(result.inputCost, 0);
    assert.equal(result.outputCost, 0);
    assert.equal(result.totalCost, 0);
});

test('estimateOpenAIImageGenerationCost keeps auto settings unresolved so callers can treat cost as unknown', () => {
    const result = estimateOpenAIImageGenerationCost({
        model: 'gpt-image-1-mini',
        quality: 'auto',
        size: 'auto',
    });

    assert.equal(result.effectiveQuality, 'auto');
    assert.equal(result.effectiveSize, 'auto');
    assert.equal(result.perImageCost, 0);
    assert.equal(result.totalCost, 0);
});

test('estimateOpenAIImageGenerationCost multiplies per-image cost by image count', () => {
    const result = estimateOpenAIImageGenerationCost({
        model: 'gpt-image-1-mini',
        quality: 'medium',
        size: '1024x1536',
        imageCount: 2,
    });

    assert.equal(result.perImageCost, 0.015);
    assert.equal(result.totalCost, 0.03);
});

test('estimateOpenAIImageGenerationCost adds the partial preview surcharge', () => {
    const result = estimateOpenAIImageGenerationCost({
        model: 'gpt-image-1-mini',
        quality: 'medium',
        size: '1024x1536',
        imageCount: 2,
        partialImageCount: 2,
    });

    assert.equal(result.partialImageCount, 2);
    assert.equal(result.perImageCost, 0.015);
    assert.ok(Math.abs(result.totalCost - 0.0316) < 1e-12);
});

test('supportedPricedOpenAITextModels includes the shared text registry plus embedding models', () => {
    for (const model of supportedOpenAITextModels) {
        assert.equal(supportedPricedOpenAITextModels.includes(model), true);
    }

    assert.equal(
        supportedPricedOpenAITextModels.includes('text-embedding-3-small'),
        true
    );
});
