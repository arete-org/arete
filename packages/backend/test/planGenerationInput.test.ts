/**
 * @description: Verifies post-plan message and snapshot assembly remains stable.
 * @footnote-scope: test
 * @footnote-module: PlanGenerationInputTests
 * @footnote-risk: medium - Assembly drift can break planner payload ordering and runtime grounding hints.
 * @footnote-ethics: medium - Stable assembly preserves auditable planner-to-generation boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostChatRequest } from '@footnote/contracts/web';
import { assemblePlanGenerationInput } from '../src/services/chatService/planGenerationInput.js';
import type { ConversationContextEnvelope } from '../src/services/conversationContextService.js';

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

const createContextEnvelope = (): ConversationContextEnvelope => ({
    participants: [
        {
            speakerId: 'user',
            speakerLabel: 'User',
            roleHint: 'user',
        },
    ],
    turns: [
        {
            turnId: 'turn_0',
            role: 'user',
            speakerId: 'user',
            speakerLabel: 'User',
            visibility: 'model_visible',
            authority: 'conversation',
        },
    ],
    diagnostics: {
        surface: 'discord',
        totalInputMessages: 1,
        projectedMessageCount: 1,
        trimmedMessageCount: 0,
        sanitizedTimestampCount: 0,
        projectedSpeakerLabelCount: 0,
    },
});

test('assemblePlanGenerationInput appends planner payload and preserves message ordering', () => {
    const result = assemblePlanGenerationInput({
        systemPrompt: 'system prompt',
        personaPrompt: 'persona prompt',
        normalizedConversation: [{ role: 'user', content: 'hello' }],
        contextEnvelope: createContextEnvelope(),
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

test('assemblePlanGenerationInput includes planner snapshot payload fields', () => {
    const result = assemblePlanGenerationInput({
        systemPrompt: 'system prompt',
        personaPrompt: 'persona prompt',
        normalizedConversation: [{ role: 'user', content: 'hello' }],
        contextEnvelope: createContextEnvelope(),
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
        contextEnvelope?: { diagnostics?: { projectedMessageCount?: number } };
    };
    assert.equal(snapshot.planner?.toolIntent?.toolName, 'weather_forecast');
    assert.equal(snapshot.planner?.toolRequest?.toolName, 'weather_forecast');
    assert.equal(snapshot.executionContract?.policyId, 'policy-test');
    assert.equal(
        snapshot.contextEnvelope?.diagnostics?.projectedMessageCount,
        1
    );
});

test('assemblePlanGenerationInput snapshot minimizes context envelope payload', () => {
    const result = assemblePlanGenerationInput({
        systemPrompt: 'system prompt',
        personaPrompt: 'persona prompt',
        normalizedConversation: [{ role: 'user', content: 'hello' }],
        contextEnvelope: createContextEnvelope(),
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
    const snapshot = JSON.parse(result.conversationSnapshot) as {
        contextEnvelope?: {
            participants?: unknown;
            turns?: unknown;
            counts?: { participantCount?: number };
        };
    };
    assert.equal(snapshot.contextEnvelope?.participants, undefined);
    assert.equal(snapshot.contextEnvelope?.turns, undefined);
    assert.equal(snapshot.contextEnvelope?.counts?.participantCount, 1);
});
