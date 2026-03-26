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
    type AssistantResponseMetadata,
    buildResponseMetadata,
    type ResponseMetadataRuntimeContext,
} from '../src/services/openaiService.js';

const baseAssistantMetadata = (
    overrides: Partial<AssistantResponseMetadata> = {}
): AssistantResponseMetadata => ({
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

test('buildResponseMetadata derives conservative chips for retrieved current-facts responses with no citations', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ citations: [] }),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: true,
                intent: 'current_facts',
                contextSize: 'low',
            },
        })
    );

    assert.equal(metadata.evidenceScore, 2);
    assert.equal(metadata.freshnessScore, 3);
});

test('buildResponseMetadata derives chips for retrieved current-facts responses with one citation', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: true,
                intent: 'current_facts',
                contextSize: 'low',
            },
        })
    );

    assert.equal(metadata.evidenceScore, 3);
    assert.equal(metadata.freshnessScore, 4);
});

test('buildResponseMetadata derives stronger evidence for retrieved current-facts responses with multiple citations', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({
            citations: [
                { title: 'One', url: 'https://example.com/1' },
                { title: 'Two', url: 'https://example.com/2' },
                { title: 'Three', url: 'https://example.com/3' },
            ],
        }),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: true,
                intent: 'current_facts',
                contextSize: 'high',
            },
        })
    );

    assert.equal(metadata.evidenceScore, 4);
    assert.equal(metadata.freshnessScore, 4);
});

test('buildResponseMetadata derives repo-explainer freshness more conservatively', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({
            citations: [
                { title: 'One', url: 'https://example.com/1' },
                { title: 'Two', url: 'https://example.com/2' },
                { title: 'Three', url: 'https://example.com/3' },
                { title: 'Four', url: 'https://example.com/4' },
            ],
        }),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: true,
                intent: 'repo_explainer',
                contextSize: 'medium',
            },
        })
    );

    assert.equal(metadata.evidenceScore, 5);
    assert.equal(metadata.freshnessScore, 3);
});

test('buildResponseMetadata preserves explicit chip values when present', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({
            evidenceScore: 5,
            freshnessScore: 2,
        }),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: true,
                intent: 'current_facts',
                contextSize: 'low',
            },
        })
    );

    assert.equal(metadata.evidenceScore, 5);
    assert.equal(metadata.freshnessScore, 2);
});

test('buildResponseMetadata does not add chips for non-retrieved responses', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ provenance: 'Speculative' }),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: true,
                intent: 'current_facts',
                contextSize: 'low',
            },
        })
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
        baseRuntimeContext()
    );

    assert.equal(metadata.tradeoffCount, 0);
});

test('buildResponseMetadata writes execution timeline from runtime context', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                planner: {
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                },
                tool: {
                    toolName: 'web_search',
                    status: 'executed',
                },
                generation: {
                    profileId: 'openai-text-medium',
                    provider: 'openai',
                    model: 'gpt-5-mini',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'planner',
            status: 'executed',
            profileId: 'openai-text-fast',
            provider: 'openai',
            model: 'gpt-5-nano',
        },
        {
            kind: 'tool',
            status: 'executed',
            toolName: 'web_search',
        },
        {
            kind: 'generation',
            status: 'executed',
            profileId: 'openai-text-medium',
            provider: 'openai',
            model: 'gpt-5-mini',
        },
    ]);
});

test('buildResponseMetadata mirrors modelVersion from final generation execution model', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ model: 'fallback-model' }),
        baseRuntimeContext({
            modelVersion: 'runtime-fallback-model',
            executionContext: {
                generation: {
                    profileId: 'openai-text-quality',
                    provider: 'openai',
                    model: 'gpt-5.4-mini',
                },
            },
        })
    );

    assert.equal(metadata.modelVersion, 'gpt-5.4-mini');
});

test('buildResponseMetadata normalizes skipped tool event with fallback reasonCode', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'skipped',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'tool',
            status: 'skipped',
            toolName: 'web_search',
            reasonCode: 'unspecified_tool_outcome',
        },
    ]);
});
