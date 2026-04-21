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
    canonicalizeOpenAIModelIdForPricing,
    classifyModelProfileTextPricingCoverage,
    estimateOpenAIImageGenerationCost,
    estimateOpenAITextCost,
    resolveOpenAITextPricingModel,
    supportedPricedOpenAITextModels,
} from '../src/pricing.js';

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

test('estimateOpenAITextCost resolves versioned OpenAI model ids through canonicalization', () => {
    const result = estimateOpenAITextCost(
        'openai/gpt-5-mini/2026-03-27',
        120,
        80
    );

    assert.equal(result.inputCost, 0.00003);
    assert.equal(result.outputCost, 0.00016);
    assert.equal(result.totalCost, 0.00019);
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

test('supportedPricedOpenAITextModels includes priced models and embedding models', () => {
    const pricedModels = supportedPricedOpenAITextModels as readonly string[];

    assert.equal(supportedPricedOpenAITextModels.includes('gpt-5-mini'), true);
    assert.equal(
        supportedPricedOpenAITextModels.includes('text-embedding-3-small'),
        true
    );
    assert.equal(supportedPricedOpenAITextModels.includes('gpt-5.4-pro'), true);
    assert.equal(pricedModels.includes('computer-use-preview'), false);
});

test('canonicalizeOpenAIModelIdForPricing strips only recognized suffix formats', () => {
    const canonicalized = canonicalizeOpenAIModelIdForPricing(
        ' OpenAI/GPT-5-Mini/2026-03-27 '
    );

    assert.equal(canonicalized.canonicalModel, 'gpt-5-mini');
    assert.equal(canonicalized.wasCanonicalized, true);
    assert.deepEqual(canonicalized.appliedRules, [
        'trim',
        'lowercase',
        'remove_openai_prefix',
        'strip_slash_date_suffix',
    ]);
});

test('resolveOpenAITextPricingModel resolves versioned gpt-5.4-mini ids after canonicalization', () => {
    const resolved = resolveOpenAITextPricingModel(
        'openai/gpt-5.4-mini/2026-03-27'
    );

    assert.equal(resolved.canonicalModel, 'gpt-5.4-mini');
    assert.equal(resolved.matchedModel, 'gpt-5.4-mini');
});

test('classifyModelProfileTextPricingCoverage marks non-openai providers as explicit policy unpriced', () => {
    const coverage = classifyModelProfileTextPricingCoverage(
        'ollama',
        'qwen3.5:cloud'
    );

    assert.equal(coverage.classification, 'unpriced_by_policy');
    assert.equal(
        coverage.policyReason,
        'non_openai_not_priced_by_backend_policy'
    );
});

test('classifyModelProfileTextPricingCoverage marks gpt-5.4-mini as priced', () => {
    const coverage = classifyModelProfileTextPricingCoverage(
        'openai',
        'gpt-5.4-mini'
    );

    assert.equal(coverage.classification, 'priced');
    assert.equal(coverage.policyReason, 'openai_priced');
});
