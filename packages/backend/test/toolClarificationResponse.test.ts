/**
 * @description: Verifies clarification response assembly keeps metadata and execution semantics stable.
 * @footnote-scope: test
 * @footnote-module: ToolClarificationResponseTests
 * @footnote-risk: low - Narrow unit coverage for response shaping helper only.
 * @footnote-ethics: medium - Clarification paths must clearly record skipped generation and tool context.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
    ResponseMetadata,
    ToolExecutionContext,
} from '@footnote/contracts/ethics-core';
import type { ResponseMetadataRuntimeContext } from '../src/services/openaiService.js';
import { createMetadata } from './fixtures/responseMetadataFixture.js';
import { buildToolClarificationResponse } from '../src/services/tools/toolClarificationResponse.js';

test('buildToolClarificationResponse formats numbered options and preserves execution contexts', () => {
    let capturedRuntimeContext: ResponseMetadataRuntimeContext | undefined;
    const toolContext: ToolExecutionContext = {
        toolName: 'weather_forecast',
        status: 'executed',
        clarification: {
            reasonCode: 'ambiguous_location',
            question: 'Which New York did you mean?',
            options: [
                {
                    id: 'nyc',
                    label: 'New York City, New York, United States',
                },
                {
                    id: 'nys',
                    label: 'New York State, United States',
                },
            ],
        },
        durationMs: 12,
    };

    const response = buildToolClarificationResponse({
        toolContext,
        metadataContext: {
            modelVersion: 'gpt-5-mini',
            conversationSnapshot: '{"request":"weather"}',
            executionContext: {
                planner: {
                    status: 'executed',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'structured',
                    applyOutcome: 'applied',
                    mattered: true,
                    matteredControlIds: ['tool_allowance'],
                    profileId: 'planner',
                    provider: 'openai',
                    model: 'gpt-5-nano',
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
                },
                generation: {
                    status: 'executed',
                    profileId: 'openai-text-medium',
                    provider: 'openai',
                    model: 'gpt-5-mini',
                },
            },
        },
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedRuntimeContext = runtimeContext;
            return {
                ...createMetadata(),
                execution: [
                    {
                        kind: 'generation',
                        status: 'skipped',
                    },
                    {
                        kind: 'tool',
                        toolName: 'old_tool',
                        status: 'failed',
                        reasonCode: 'tool_execution_error',
                    },
                ],
            } satisfies ResponseMetadata;
        },
    });

    assert.equal(response.action, 'message');
    assert.equal(response.modality, 'text');
    assert.match(response.message, /Which New York did you mean\?/);
    assert.match(response.message, /1\. New York City/);
    assert.match(response.message, /2\. New York State/);
    assert.match(response.message, /Please reply with your choice\./);

    assert.equal(
        capturedRuntimeContext?.executionContext?.generation?.status,
        'skipped'
    );
    assert.deepEqual(
        capturedRuntimeContext?.executionContext?.planner?.profileId,
        'planner'
    );
    assert.equal(
        capturedRuntimeContext?.executionContext?.evaluator?.status,
        'executed'
    );

    const toolEvents =
        response.metadata.execution?.filter((event) => event.kind === 'tool') ??
        [];
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0]?.toolName, 'weather_forecast');
    assert.equal(toolEvents[0]?.status, 'executed');
    assert.equal(
        toolEvents[0]?.clarification?.reasonCode,
        'ambiguous_location'
    );
});
