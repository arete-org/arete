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

test('buildResponseMetadata emits canonical trace_target and trace_final fields', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            plannerTemperament: {
                tightness: 4,
                rationale: 3,
            },
        })
    );

    assert.deepEqual(metadata.trace_target, {
        tightness: 4,
        rationale: 3,
    });
    assert.deepEqual(metadata.trace_final, {
        tightness: 4,
        rationale: 3,
    });
    assert.equal(metadata.trace_final_reason_code, undefined);
});

test('buildResponseMetadata emits trace_final_reason_code when final posture differs', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            plannerTemperament: {
                tightness: 2,
            },
            finalTemperament: {
                tightness: 4,
            },
            temperamentFinalizationReasonCode: 'runtime_posture_adjustment',
        })
    );

    assert.deepEqual(metadata.trace_target, {
        tightness: 2,
    });
    assert.deepEqual(metadata.trace_final, {
        tightness: 4,
    });
    assert.equal(
        metadata.trace_final_reason_code,
        'runtime_posture_adjustment'
    );
});

test('buildResponseMetadata defaults trace_final_reason_code when final posture differs without explicit code', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            plannerTemperament: {
                tightness: 2,
            },
            finalTemperament: {
                tightness: 4,
            },
        })
    );

    assert.deepEqual(metadata.trace_target, {
        tightness: 2,
    });
    assert.deepEqual(metadata.trace_final, {
        tightness: 4,
    });
    assert.equal(
        metadata.trace_final_reason_code,
        'runtime_posture_adjustment'
    );
});

test('buildResponseMetadata includes steerability controls when provided by runtime context', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            steerabilityControls: {
                version: 'v1',
                controls: [
                    {
                        controlId: 'workflow_mode',
                        value: 'balanced',
                        source: 'runtime_config',
                        rationale: 'Configured mode selected.',
                        mattered: true,
                        impactedTargets: ['workflow_execution'],
                    },
                ],
            },
        })
    );

    assert.deepEqual(metadata.steerabilityControls, {
        version: 'v1',
        controls: [
            {
                controlId: 'workflow_mode',
                value: 'balanced',
                source: 'runtime_config',
                rationale: 'Configured mode selected.',
                mattered: true,
                impactedTargets: ['workflow_execution'],
            },
        ],
    });
});

test('buildResponseMetadata writes execution timeline from runtime context', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                planner: {
                    status: 'executed',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'structured',
                    applyOutcome: 'applied',
                    mattered: true,
                    matteredControlIds: ['provider_preference'],
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                    durationMs: 12,
                },
                evaluator: {
                    status: 'executed',
                    outcome: {
                        authorityLevel: 'observe',
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
            kind: 'evaluator',
            status: 'executed',
            evaluator: {
                authorityLevel: 'observe',
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
        authorityLevel: 'observe',
        mode: 'observe_only',
        provenance: 'Inferred',
        safetyDecision: {
            action: 'allow',
            safetyTier: 'Low',
            ruleId: null,
        },
    });
});

test('buildResponseMetadata ignores planner execution bridge fields and keeps execution timeline non-planner only', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            workflow: {
                workflowId: 'wf_123',
                workflowName: 'message_with_review_loop',
                status: 'completed',
                terminationReason: 'goal_satisfied',
                stepCount: 2,
                maxSteps: 3,
                maxDurationMs: 15000,
                steps: [
                    {
                        stepId: 'step_plan_1',
                        attempt: 1,
                        stepKind: 'plan',
                        startedAt: '2026-04-01T00:00:00.000Z',
                        finishedAt: '2026-04-01T00:00:00.010Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary:
                                'Planner step emitted bounded action-selection summary.',
                        },
                    },
                    {
                        stepId: 'step_1',
                        attempt: 1,
                        stepKind: 'generate',
                        startedAt: '2026-04-01T00:00:00.011Z',
                        finishedAt: '2026-04-01T00:00:00.020Z',
                        durationMs: 9,
                        outcome: {
                            status: 'executed',
                            summary: 'Generated initial draft response.',
                        },
                    },
                ],
            },
            executionContext: {
                planner: {
                    status: 'executed',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'structured',
                    applyOutcome: 'applied',
                    mattered: true,
                    matteredControlIds: ['provider_preference'],
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                    durationMs: 12,
                },
                generation: {
                    status: 'executed',
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

test('buildResponseMetadata ignores failed planner execution bridge fields', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                planner: {
                    status: 'failed',
                    reasonCode: 'planner_runtime_error',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'fallback',
                    applyOutcome: 'not_applied',
                    mattered: false,
                    matteredControlIds: [],
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                },
            },
        })
    );

    assert.equal(metadata.execution, undefined);
});

test('buildResponseMetadata ignores planner execution bridge fields regardless of planner reasonCode validity', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                planner: {
                    status: 'failed',
                    reasonCode: 'tool_execution_error',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'fallback',
                    applyOutcome: 'not_applied',
                    mattered: false,
                    matteredControlIds: [],
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                },
            },
        })
    );

    assert.equal(metadata.execution, undefined);
});

test('buildResponseMetadata does not emit evaluator/generation reasonCode for skipped status and ignores planner bridge', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            executionContext: {
                planner: {
                    status: 'skipped',
                    reasonCode: 'planner_runtime_error',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'fallback',
                    applyOutcome: 'not_applied',
                    mattered: false,
                    matteredControlIds: [],
                    profileId: 'openai-text-fast',
                    provider: 'openai',
                    model: 'gpt-5-nano',
                },
                evaluator: {
                    status: 'skipped',
                    reasonCode: 'evaluator_runtime_error',
                },
                generation: {
                    status: 'skipped',
                    reasonCode: 'generation_runtime_error',
                    profileId: 'openai-text-medium',
                    provider: 'openai',
                    model: 'gpt-5-mini',
                },
            },
        })
    );

    assert.deepEqual(metadata.execution, [
        {
            kind: 'evaluator',
            status: 'skipped',
        },
        {
            kind: 'generation',
            status: 'skipped',
            profileId: 'openai-text-medium',
            provider: 'openai',
            model: 'gpt-5-mini',
        },
    ]);
});

test('buildResponseMetadata drops invalid generation reasonCode instead of rewriting it', () => {
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

test('buildResponseMetadata keeps failed evaluator event without a reasonCode when unavailable', () => {
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

test('buildResponseMetadata defaults reviewRuntime to not_reviewed when no review path metadata exists', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext()
    );

    assert.deepEqual(metadata.reviewRuntime, {
        label: 'not_reviewed',
    });
});

test('buildResponseMetadata sets reviewRuntime to reviewed_no_revision when assess executed without revise', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            workflow: {
                workflowId: 'wf_1',
                workflowName: 'message_with_review_loop',
                status: 'completed',
                terminationReason: 'goal_satisfied',
                stepCount: 2,
                maxSteps: 4,
                maxDurationMs: 12000,
                steps: [
                    {
                        stepId: 'step_generate_1',
                        attempt: 1,
                        stepKind: 'generate',
                        startedAt: '2026-04-22T00:00:00.000Z',
                        finishedAt: '2026-04-22T00:00:00.010Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary: 'Generated initial draft response.',
                        },
                    },
                    {
                        stepId: 'step_assess_1',
                        attempt: 1,
                        stepKind: 'assess',
                        startedAt: '2026-04-22T00:00:00.011Z',
                        finishedAt: '2026-04-22T00:00:00.021Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary: 'Assessment step evaluated draft quality.',
                            signals: {
                                reviewDecision: 'finalize',
                                reviewReason:
                                    'Draft is ready for final response.',
                            },
                        },
                    },
                ],
            },
        })
    );

    assert.deepEqual(metadata.reviewRuntime, {
        label: 'reviewed_no_revision',
    });
});

test('buildResponseMetadata sets reviewRuntime to revised when revise step executed', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            workflow: {
                workflowId: 'wf_2',
                workflowName: 'message_with_review_loop',
                status: 'completed',
                terminationReason: 'goal_satisfied',
                stepCount: 3,
                maxSteps: 6,
                maxDurationMs: 15000,
                steps: [
                    {
                        stepId: 'step_generate_1',
                        attempt: 1,
                        stepKind: 'generate',
                        startedAt: '2026-04-22T00:00:00.000Z',
                        finishedAt: '2026-04-22T00:00:00.010Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary: 'Generated initial draft response.',
                        },
                    },
                    {
                        stepId: 'step_assess_1',
                        attempt: 1,
                        stepKind: 'assess',
                        startedAt: '2026-04-22T00:00:00.011Z',
                        finishedAt: '2026-04-22T00:00:00.021Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary: 'Assessment step evaluated draft quality.',
                            signals: {
                                reviewDecision: 'revise',
                                reviewReason:
                                    'One revision improves specificity.',
                            },
                        },
                    },
                    {
                        stepId: 'step_revise_1',
                        attempt: 1,
                        stepKind: 'revise',
                        startedAt: '2026-04-22T00:00:00.022Z',
                        finishedAt: '2026-04-22T00:00:00.032Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary: 'Revision step produced improved draft.',
                        },
                    },
                ],
            },
        })
    );

    assert.deepEqual(metadata.reviewRuntime, {
        label: 'revised',
    });
});

test('buildResponseMetadata sets reviewRuntime to skipped when review pass was expected but no assess step executed', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            workflowMode: {
                modeId: 'grounded',
                selectedBy: 'requested_mode',
                selectionReason: 'Requested by user.',
                initial_mode: 'grounded',
                behavior: {
                    executionContractPresetId: 'quality-grounded',
                    workflowProfileClass: 'reviewed',
                    workflowProfileId: 'bounded-review',
                    workflowExecution: 'always',
                    reviewPass: 'included',
                    reviseStep: 'allowed',
                    evidencePosture: 'strict',
                    maxWorkflowSteps: 8,
                    maxDeliberationCalls: 3,
                },
            },
            workflow: {
                workflowId: 'wf_3',
                workflowName: 'message_with_review_loop',
                status: 'degraded',
                terminationReason: 'budget_exhausted_steps',
                stepCount: 1,
                maxSteps: 1,
                maxDurationMs: 5000,
                steps: [
                    {
                        stepId: 'step_generate_1',
                        attempt: 1,
                        stepKind: 'generate',
                        startedAt: '2026-04-22T00:00:00.000Z',
                        finishedAt: '2026-04-22T00:00:00.010Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary: 'Generated initial draft response.',
                        },
                    },
                ],
            },
        })
    );

    assert.deepEqual(metadata.reviewRuntime, {
        label: 'skipped',
    });
});

test('buildResponseMetadata sets reviewRuntime to fallback when fail-open fallback path was recorded', () => {
    const metadata = buildResponseMetadata(
        baseAssistantMetadata(),
        baseRuntimeContext({
            workflow: {
                workflowId: 'wf_4',
                workflowName: 'message_with_review_loop',
                status: 'degraded',
                terminationReason: 'executor_error_fail_open',
                stepCount: 2,
                maxSteps: 4,
                maxDurationMs: 12000,
                steps: [
                    {
                        stepId: 'step_generate_1',
                        attempt: 1,
                        stepKind: 'generate',
                        startedAt: '2026-04-22T00:00:00.000Z',
                        finishedAt: '2026-04-22T00:00:00.010Z',
                        durationMs: 10,
                        outcome: {
                            status: 'executed',
                            summary: 'Generated initial draft response.',
                        },
                    },
                    {
                        stepId: 'step_assess_1',
                        attempt: 1,
                        stepKind: 'assess',
                        reasonCode: 'generation_runtime_error',
                        startedAt: '2026-04-22T00:00:00.011Z',
                        finishedAt: '2026-04-22T00:00:00.021Z',
                        durationMs: 10,
                        outcome: {
                            status: 'failed',
                            summary: 'Assessment failed.',
                        },
                    },
                ],
            },
        })
    );

    assert.deepEqual(metadata.reviewRuntime, {
        label: 'fallback',
    });
});
