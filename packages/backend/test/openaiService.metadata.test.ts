/**
 * @description: Verifies backend response metadata construction for TRACE chips.
 * @footnote-scope: test
 * @footnote-module: OpenAIServiceMetadataTests
 * @footnote-risk: medium - Regressions here can silently drop or misstate provenance chip values.
 * @footnote-ethics: high - Incorrect chip defaults can mislead users about evidence and freshness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildResponseMetadata,
    type OpenAIResponseMetadata,
    type ResponseMetadataRuntimeContext,
} from '../src/services/openaiService.js';

const baseAssistantMetadata = (
    overrides: Partial<OpenAIResponseMetadata> = {}
): OpenAIResponseMetadata => ({
    model: 'gpt-5-mini',
    provenance: 'Retrieved',
    tradeoffCount: 1,
    citations: [{ title: 'Source', url: 'https://example.com' }],
    ...overrides,
});

const baseRuntimeContext = (
    overrides: Partial<ResponseMetadataRuntimeContext> = {}
): ResponseMetadataRuntimeContext => ({
    modelVersion: 'gpt-5-mini',
    conversationSnapshot: 'snapshot',
    ...overrides,
});

test('buildResponseMetadata leaves chips omitted when retrieved web-search chips are missing', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({ usedWebSearch: true })
    );

    assert.equal(metadata.evidenceScore, undefined);
    assert.equal(metadata.freshnessScore, undefined);
});

test('buildResponseMetadata does not backfill chips when web search was not used', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({ usedWebSearch: false })
    );

    assert.equal(metadata.evidenceScore, undefined);
    assert.equal(metadata.freshnessScore, undefined);
});

test('buildResponseMetadata preserves explicit chip values when present', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({
            evidenceScore: 5,
            freshnessScore: 2,
        }),
        baseRuntimeContext({ usedWebSearch: true })
    );

    assert.equal(metadata.evidenceScore, 5);
    assert.equal(metadata.freshnessScore, 2);
});

test('buildResponseMetadata does not add chips for non-retrieved responses', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ provenance: 'Speculative' }),
        baseRuntimeContext({ usedWebSearch: true })
    );

    assert.equal(metadata.evidenceScore, undefined);
    assert.equal(metadata.freshnessScore, undefined);
});

test('buildResponseMetadata uses planner fallback tradeoffCount when assistant metadata omits count', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ tradeoffCount: undefined }),
        baseRuntimeContext({
            plannerTemperament: { extent: 4 },
        })
    );

    assert.equal(metadata.tradeoffCount, 1);
});

test('buildResponseMetadata keeps explicit assistant tradeoffCount over planner fallback', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ tradeoffCount: 3 }),
        baseRuntimeContext({
            plannerTemperament: { extent: 5 },
        })
    );

    assert.equal(metadata.tradeoffCount, 3);
});

test('buildResponseMetadata defaults tradeoffCount to 0 when assistant and planner fallback are absent', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ tradeoffCount: undefined }),
        baseRuntimeContext({
            plannerTemperament: { extent: 2 },
        })
    );

    assert.equal(metadata.tradeoffCount, 0);
});
