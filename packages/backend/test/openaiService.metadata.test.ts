/**
 * @description: Verifies backend response metadata construction for TRACE chips.
 * @footnote-scope: test
 * @footnote-module: OpenAIServiceMetadataTests
 * @footnote-risk: medium - Regressions here can silently drop or misstate provenance chip values.
 * @footnote-ethics: high - Incorrect chip defaults can mislead users about evidence and freshness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolInvocationReasonCode } from '@footnote/contracts/ethics-core';

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
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'executed',
                },
            },
        })
    );

    assert.equal(metadata.evidenceScore, 2);
    assert.equal(metadata.freshnessScore, 3);
    assert.equal(
        metadata.provenanceAssessment?.methodId,
        'deterministic_multi_signal_v1'
    );
    assert.equal(metadata.provenanceAssessment?.signals.retrievalUsed, true);
    assert.deepEqual(metadata.provenanceAssessment?.conflicts, [
        'retrieval_used_without_citations',
    ]);
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
        baseAssistantMetadata({ provenance: 'Speculative', citations: [] }),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: false,
                intent: 'current_facts',
                contextSize: 'low',
            },
        })
    );

    assert.equal(metadata.provenance, 'Speculative');
    assert.equal(metadata.evidenceScore, undefined);
    assert.equal(metadata.freshnessScore, undefined);
});

test('buildResponseMetadata can classify as retrieved from execution-derived signals without citations', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({
            provenance: 'Inferred',
            citations: [],
        }),
        baseRuntimeContext({
            retrieval: {
                requested: true,
                used: true,
                intent: 'current_facts',
                contextSize: 'low',
            },
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'executed',
                },
            },
        })
    );

    assert.equal(metadata.provenance, 'Retrieved');
    assert.equal(metadata.evidenceScore, 2);
    assert.equal(metadata.freshnessScore, 3);
    assert.equal(
        metadata.provenanceAssessment?.signals.retrievalToolExecuted,
        true
    );
});

test('buildResponseMetadata does not classify as retrieved when TrustGraph evidence is available but unused and uncorroborated', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({
            provenance: 'Inferred',
            citations: [],
        }),
        baseRuntimeContext({
            retrieval: {
                requested: false,
                used: false,
            },
            trustGraphEvidenceAvailable: true,
            trustGraphEvidenceUsed: false,
        })
    );

    assert.equal(metadata.provenance, 'Inferred');
    assert.equal(
        metadata.provenanceAssessment?.signals.trustGraphEvidenceAvailable,
        true
    );
    assert.equal(
        metadata.provenanceAssessment?.signals.trustGraphEvidenceUsed,
        false
    );
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
                    status: 'executed',
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                    durationMs: 12,
                },
                evaluator: {
                    status: 'executed',
                    outcome: {
                        mode: 'observe_only',
                        provenance: 'Inferred',
                        safetyDecision: {
                            action: 'allow',
                            safetyTier: 'Low',
                            ruleId: null,
                        },
                    },
                    durationMs: 3,
                },
                tool: {
                    toolName: 'web_search',
                    status: 'executed',
                    durationMs: 8,
                },
                generation: {
                    status: 'executed',
                    profileId: 'openai-text-medium',
                    provider: 'openai',
                    model: 'gpt-5-mini',
                    durationMs: 34,
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
            durationMs: 12,
        },
        {
            kind: 'evaluator',
            status: 'executed',
            evaluator: {
                mode: 'observe_only',
                provenance: 'Inferred',
                safetyDecision: {
                    action: 'allow',
                    safetyTier: 'Low',
                    ruleId: null,
                },
            },
            durationMs: 3,
        },
        {
            kind: 'tool',
            status: 'executed',
            toolName: 'web_search',
            durationMs: 8,
        },
        {
            kind: 'generation',
            status: 'executed',
            profileId: 'openai-text-medium',
            provider: 'openai',
            model: 'gpt-5-mini',
            durationMs: 34,
        },
    ]);
    assert.deepEqual(metadata.evaluator, {
        mode: 'observe_only',
        provenance: 'Inferred',
        safetyDecision: {
            action: 'allow',
            safetyTier: 'Low',
            ruleId: null,
        },
    });
});

test('buildResponseMetadata mirrors modelVersion from final generation execution model', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata({ model: 'fallback-model' }),
        baseRuntimeContext({
            modelVersion: 'runtime-fallback-model',
            executionContext: {
                generation: {
                    status: 'executed',
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

test('buildResponseMetadata preserves executed tool reasonCode for reroute auditability', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'executed',
                    reasonCode: 'search_rerouted_to_fallback_profile',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'tool',
            status: 'executed',
            toolName: 'web_search',
            reasonCode: 'search_rerouted_to_fallback_profile',
        },
    ]);
});

test('buildResponseMetadata preserves tool_unavailable reasonCode for skipped tool outcomes and JSON serialization', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'skipped',
                    reasonCode: 'tool_unavailable',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'tool',
            status: 'skipped',
            toolName: 'web_search',
            reasonCode: 'tool_unavailable',
        },
    ]);
    assert.deepEqual(
        JSON.parse(JSON.stringify(metadata)).execution,
        metadata.execution
    );
});

test('buildResponseMetadata normalizes failed tool event with fallback reasonCode', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'failed',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'tool',
            status: 'failed',
            toolName: 'web_search',
            reasonCode: 'tool_execution_error',
        },
    ]);
});

test('buildResponseMetadata keeps failed planner reasonCode in execution timeline', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                planner: {
                    status: 'failed',
                    reasonCode: 'planner_runtime_error',
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'planner',
            status: 'failed',
            reasonCode: 'planner_runtime_error',
            profileId: 'openai-text-fast',
            provider: 'openai',
            model: 'gpt-5-nano',
        },
    ]);
});

test('buildResponseMetadata normalizes invalid planner reasonCode to planner_runtime_error', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                planner: {
                    status: 'failed',
                    reasonCode: 'tool_execution_error',
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'planner',
            status: 'failed',
            reasonCode: 'planner_runtime_error',
            profileId: 'openai-text-fast',
            provider: 'openai',
            model: 'gpt-5-nano',
        },
    ]);
});

test('buildResponseMetadata normalizes invalid generation reasonCode to generation_runtime_error', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                generation: {
                    status: 'failed',
                    reasonCode: 'planner_runtime_error',
                    profileId: 'openai-text-medium',
                    provider: 'openai',
                    model: 'gpt-5-mini',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'generation',
            status: 'failed',
            reasonCode: 'generation_runtime_error',
            profileId: 'openai-text-medium',
            provider: 'openai',
            model: 'gpt-5-mini',
        },
    ]);
});

test('buildResponseMetadata normalizes invalid tool reasonCode by status defaults', () => {
    const skippedMetadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'skipped',
                    reasonCode:
                        'planner_runtime_error' as unknown as ToolInvocationReasonCode,
                },
            },
        })
    );

    assert.deepEqual(skippedMetadata.execution, [
        {
            kind: 'tool',
            status: 'skipped',
            toolName: 'web_search',
            reasonCode: 'unspecified_tool_outcome',
        },
    ]);

    const failedMetadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                tool: {
                    toolName: 'web_search',
                    status: 'failed',
                    reasonCode:
                        'planner_runtime_error' as unknown as ToolInvocationReasonCode,
                },
            },
        })
    );

    assert.deepEqual(failedMetadata.execution, [
        {
            kind: 'tool',
            status: 'failed',
            toolName: 'web_search',
            reasonCode: 'tool_execution_error',
        },
    ]);
});

test('buildResponseMetadata normalizes failed evaluator event with fallback reasonCode', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                evaluator: {
                    status: 'failed',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'evaluator',
            status: 'failed',
            reasonCode: 'evaluator_runtime_error',
        },
    ]);
    assert.equal(metadata.evaluator, undefined);
});

test('buildResponseMetadata includes totalDurationMs when runtime context provides it', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            totalDurationMs: 1234,
        })
    );

    assert.equal(metadata.totalDurationMs, 1234);
});
