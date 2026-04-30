/**
 * @description: Verifies post-plan message and snapshot assembly remains stable.
 * @footnote-scope: test
 * @footnote-module: PostPlanAssemblyTests
 * @footnote-risk: medium - Assembly drift can break planner payload ordering and runtime grounding hints.
 * @footnote-ethics: medium - Stable assembly preserves auditable planner-to-generation boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostChatRequest } from '@footnote/contracts/web';
import { assemblePostPlanGenerationInput } from '../src/services/chatService/postPlanAssembly.js';

const createRequest = (): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'hello',
    conversation: [{ role: 'user', content: 'hello' }],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
});

test('assemblePostPlanGenerationInput appends planner payload and preserves message ordering', () => {
    const result = assemblePostPlanGenerationInput({
        systemPrompt: 'system prompt',
        personaPrompt: 'persona prompt',
        normalizedConversation: [{ role: 'user', content: 'hello' }],
        executionPlanForPrompt: {
            action: 'message',
            modality: 'text',
            safetyTier: 'Low',
            reasoning: 'reason',
            generation: {
                reasoningEffort: 'low',
                verbosity: 'low',
            },
            profileId: 'generate-only',
        },
        normalizedRequest: createRequest(),
        orchestrationSafetyTier: 'Low',
        toolRequestContext: {
            toolName: 'weather_forecast',
            requested: false,
            eligible: false,
            reasonCode: 'tool_not_requested',
        },
        executionContract: {
            policyId: 'policy-test',
            policyVersion: '1',
        },
    });

    assert.equal(result.conversationMessages.length, 4);
    assert.equal(result.conversationMessages[0]?.content, 'system prompt');
    assert.equal(result.conversationMessages[1]?.content, 'persona prompt');
    assert.equal(result.conversationMessages[2]?.content, 'hello');
    assert.match(
        result.conversationMessages[3]?.content ?? '',
        /BEGIN Planner Output/
    );
    assert.match(
        result.conversationMessages[3]?.content ?? '',
        /END Planner Output/
    );
});

test('assemblePostPlanGenerationInput includes planner snapshot payload fields', () => {
    const result = assemblePostPlanGenerationInput({
        systemPrompt: 'system prompt',
        personaPrompt: 'persona prompt',
        normalizedConversation: [{ role: 'user', content: 'hello' }],
        executionPlanForPrompt: {
            action: 'message',
            modality: 'text',
            safetyTier: 'Low',
            reasoning: 'reason',
            generation: {
                reasoningEffort: 'low',
                verbosity: 'low',
            },
            profileId: 'generate-only',
        },
        normalizedRequest: createRequest(),
        orchestrationSafetyTier: 'Low',
        toolIntent: {
            toolName: 'weather_forecast',
            requested: true,
        },
        toolRequestContext: {
            toolName: 'weather_forecast',
            requested: true,
            eligible: true,
        },
        executionContract: {
            policyId: 'policy-test',
            policyVersion: '1',
        },
    });
    const snapshot = JSON.parse(result.conversationSnapshot) as {
        planner?: {
            toolIntent?: { toolName?: string };
            toolRequest?: { toolName?: string };
        };
        executionContract?: { policyId?: string };
    };
    assert.equal(snapshot.planner?.toolIntent?.toolName, 'weather_forecast');
    assert.equal(snapshot.planner?.toolRequest?.toolName, 'weather_forecast');
    assert.equal(snapshot.executionContract?.policyId, 'policy-test');
});
