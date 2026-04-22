/**
 * @description: Verifies Discord provenance details render markdown sections with execution table and trace link.
 * @footnote-scope: test
 * @footnote-module: ProvenanceButtonDetailsTests
 * @footnote-risk: low - Test-only coverage for details rendering and fail-open behavior.
 * @footnote-ethics: medium - Clear details presentation supports transparency while preserving inspectability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ButtonInteraction } from 'discord.js';

import { botApi } from '../src/api/botApi.js';
import { handleProvenanceButtonInteraction } from '../src/interactions/button/provenanceButtons.js';

type TestInteraction = {
    customId: string;
    deferReply: (payload: unknown) => Promise<void>;
    editReply: (payload: unknown) => Promise<void>;
};

function createDetailsInteraction(
    responseId: string,
    editReplyPayloads: unknown[],
    deferReplyPayloads: unknown[]
): TestInteraction {
    return {
        customId: `details:${responseId}`,
        deferReply: async (payload: unknown) => {
            deferReplyPayloads.push(payload);
        },
        editReply: async (payload: unknown) => {
            editReplyPayloads.push(payload);
        },
    };
}

test('details action renders markdown sections with execution table and trace viewer link', async () => {
    const originalGetTrace = botApi.getTrace;
    const deferReplyPayloads: unknown[] = [];
    const editReplyPayloads: unknown[] = [];

    botApi.getTrace = (async () => ({
        status: 200,
        data: {
            responseId: 'resp_details_sections',
            provenance: 'Retrieved',
            safetyTier: 'Low',
            tradeoffCount: 2,
            chainHash: 'hash_123',
            licenseContext: 'MIT',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            totalDurationMs: 321,
            evidenceScore: 4,
            freshnessScore: 3,
            trace_target: {
                tightness: 4,
                rationale: 4,
                attribution: 5,
                caution: 3,
                extent: 4,
            },
            trace_final: {
                tightness: 4,
                rationale: 4,
                attribution: 3,
                caution: 3,
                extent: 4,
            },
            trace_final_reason_code: 'runtime_posture_adjustment',
            citations: [
                {
                    title: 'Primary source ] title',
                    url: 'https://example.com/source?q=a)',
                    snippet: 'Evidence',
                },
            ],
            workflowMode: {
                modeId: 'balanced',
                selectedBy: 'requested_mode',
                selectionReason: 'User requested balanced workflow mode.',
                initial_mode: 'balanced',
                behavior: {
                    executionContractPresetId: 'balanced',
                    workflowProfileClass: 'reviewed',
                    workflowProfileId: 'bounded-review',
                    workflowExecution: 'policy_gated',
                    reviewPass: 'excluded',
                    reviseStep: 'allowed',
                    evidencePosture: 'balanced',
                    maxWorkflowSteps: 6,
                    maxDeliberationCalls: 2,
                },
            },
            execution: [
                {
                    kind: 'planner',
                    status: 'failed',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'fallback',
                    applyOutcome: 'not_applied',
                    mattered: false,
                    matteredControlIds: [],
                    reasonCode: 'planner_runtime_error',
                },
                {
                    kind: 'generation',
                    status: 'executed',
                    model: 'gpt-5-mini',
                    durationMs: 25,
                },
                {
                    kind: 'generation',
                    status: 'executed',
                    model: 'gpt-5-mini',
                    durationMs: 140,
                },
                {
                    kind: 'evaluator',
                    status: 'executed',
                    evaluator: {
                        authorityLevel: 'influence',
                        mode: 'observe_only',
                        provenance: 'Inferred',
                        safetyDecision: {
                            action: 'block',
                            safetyTier: 'High',
                            ruleId: 'safety.weaponization_request.v1',
                            reasonCode: 'weaponization_request',
                            reason: 'Deterministic weaponization-request rule matched.',
                        },
                    },
                    durationMs: 11,
                },
            ],
        },
    })) as typeof botApi.getTrace;

    try {
        const handled = await handleProvenanceButtonInteraction(
            createDetailsInteraction(
                'resp_details_sections',
                editReplyPayloads,
                deferReplyPayloads
            ) as unknown as ButtonInteraction
        );

        assert.equal(handled, true);
        assert.equal(deferReplyPayloads.length, 1);
        assert.equal(editReplyPayloads.length, 1);

        const content = String(
            (editReplyPayloads[0] as { content?: string }).content
        );
        assert.match(content, /\*\*Summary\*\*/);
        assert.match(content, /\*\*TRACE\*\*/);
        assert.match(content, /\*\*Sources\*\*/);
        assert.match(content, /\*\*Execution\*\*/);
        assert.match(content, /\*\*Trace Viewer\*\*/);
        assert.match(content, /Open full trace/);
        assert.match(content, /\/traces\/resp_details_sections/);
        assert.match(content, /Answered in Balanced mode/);
        assert.match(content, /Review skipped/);
        assert.match(content, /Planner fallback/);
        assert.match(content, /Target Attribution: `5`/);
        assert.match(content, /Final Attribution: `3`/);
        assert.match(content, /Final Reason: `runtime_posture_adjustment`/);
        assert.match(content, /weaponization_request/);
        assert.match(content, /High\/Inferred\/block/);
        assert.match(content, /```text/);
        assert.match(
            content,
            /\[Primary source \\] title\]\(https:\/\/example\.com\/source\?q=a\\\)\)/
        );
        assert.doesNotMatch(content, /\*\*Raw JSON \(debug\)\*\*/);
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});

test('details action truncates oversized payloads while preserving section readability', async () => {
    const originalGetTrace = botApi.getTrace;
    const deferReplyPayloads: unknown[] = [];
    const editReplyPayloads: unknown[] = [];

    botApi.getTrace = (async () => ({
        status: 200,
        data: {
            responseId: 'resp_details_long',
            provenance: 'Inferred',
            safetyTier: 'Medium',
            tradeoffCount: 9,
            chainHash: 'hash_long',
            licenseContext: 'MIT',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: Array.from({ length: 30 }, (_, index) => ({
                title: `Long citation ${index} ${'x'.repeat(220)}`,
                url: `https://example.com/${index}?q=${'y'.repeat(220)}`,
                snippet: 'z'.repeat(500),
            })),
            execution: Array.from({ length: 25 }, (_, index) => ({
                kind: 'tool',
                status:
                    index % 3 === 0
                        ? 'failed'
                        : index % 3 === 1
                          ? 'skipped'
                          : 'executed',
                toolName: 'web_search',
                reasonCode:
                    index % 3 === 0 ? 'tool_execution_error' : 'tool_not_used',
                durationMs: 100 + index,
            })),
            trace_target: {
                tightness: 4,
                rationale: 4,
                attribution: 4,
                caution: 3,
                extent: 4,
            },
            trace_final: {
                tightness: 4,
                rationale: 4,
                attribution: 4,
                caution: 2,
                extent: 4,
            },
            trace_final_reason_code: 'runtime_posture_adjustment',
        },
    })) as typeof botApi.getTrace;

    try {
        const handled = await handleProvenanceButtonInteraction(
            createDetailsInteraction(
                'resp_details_long',
                editReplyPayloads,
                deferReplyPayloads
            ) as unknown as ButtonInteraction
        );
        assert.equal(handled, true);
        assert.equal(editReplyPayloads.length, 1);

        const content = String(
            (editReplyPayloads[0] as { content?: string }).content
        );
        assert.ok(content.length <= 2000);
        assert.match(content, /\*\*Summary\*\*/);
        assert.match(content, /\*\*TRACE\*\*/);
        assert.match(content, /\*\*Sources\*\*/);
        assert.match(content, /\*\*Execution\*\*/);
        assert.match(content, /\.\.\. \(truncated\)/);
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});

test('details action stays fail-open with fallback sections when trace metadata fetch fails', async () => {
    const originalGetTrace = botApi.getTrace;
    const deferReplyPayloads: unknown[] = [];
    const editReplyPayloads: unknown[] = [];

    botApi.getTrace = (async () => {
        throw new Error('trace down');
    }) as typeof botApi.getTrace;

    try {
        const handled = await handleProvenanceButtonInteraction(
            createDetailsInteraction(
                'resp_unavailable',
                editReplyPayloads,
                deferReplyPayloads
            ) as unknown as ButtonInteraction
        );

        assert.equal(handled, true);
        assert.equal(editReplyPayloads.length, 1);

        const content = String(
            (editReplyPayloads[0] as { content?: string }).content
        );
        assert.match(content, /\*\*Summary\*\*/);
        assert.match(content, /\*\*TRACE\*\*/);
        assert.match(content, /\*\*Sources\*\*/);
        assert.match(content, /\*\*Execution\*\*/);
        assert.match(content, /metadata_unavailable/);
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});
