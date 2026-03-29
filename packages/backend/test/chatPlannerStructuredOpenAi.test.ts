/**
 * @description: Verifies OpenAI structured planner execution builds function-call requests and parses tool arguments.
 * @footnote-scope: test
 * @footnote-module: ChatPlannerStructuredOpenAITests
 * @footnote-risk: medium - Missing tests here can hide planner structured-call regressions.
 * @footnote-ethics: medium - Planner execution integrity affects downstream action selection quality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpenAiChatPlannerStructuredExecutor } from '../src/services/chatPlannerStructuredOpenAi.js';

test('structured planner executor parses function_call arguments', async () => {
    const originalFetch = globalThis.fetch;
    let capturedRequestBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
        capturedRequestBody =
            typeof init?.body === 'string'
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : undefined;

        return new Response(
            JSON.stringify({
                model: 'gpt-5-nano',
                usage: {
                    input_tokens: 10,
                    output_tokens: 9,
                    total_tokens: 19,
                },
                output: [
                    {
                        type: 'function_call',
                        name: 'submit_planner_decision',
                        arguments: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            riskTier: 'Low',
                            reasoning: 'Use a normal message.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                                temperament: {
                                    tightness: 4,
                                    rationale: 3,
                                    attribution: 4,
                                    caution: 3,
                                    extent: 4,
                                },
                            },
                        }),
                    },
                ],
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }
        );
    }) as typeof fetch;

    try {
        const executeStructuredPlanner =
            createOpenAiChatPlannerStructuredExecutor({
                apiKey: 'test-key',
            });

        const result = await executeStructuredPlanner({
            messages: [
                {
                    role: 'system',
                    content: 'Planner instructions',
                },
            ],
            model: 'gpt-5-nano',
            maxOutputTokens: 700,
            reasoningEffort: 'low',
            verbosity: 'low',
        });

        assert.equal(
            (capturedRequestBody?.tool_choice as { name?: string } | undefined)
                ?.name,
            'submit_planner_decision'
        );
        assert.equal(
            Array.isArray(capturedRequestBody?.tools) &&
                capturedRequestBody?.tools?.length,
            1
        );
        assert.equal(
            (result.decision as { action?: string }).action,
            'message'
        );
        assert.equal(result.model, 'gpt-5-nano');
        assert.equal(result.usage?.totalTokens, 19);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
