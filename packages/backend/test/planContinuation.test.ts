/**
 * @description: Verifies planner action outcome classification for terminal and message-continuation paths.
 * @footnote-scope: test
 * @footnote-module: PlanContinuationTests
 * @footnote-risk: medium - Incorrect action classification can break non-message routing parity.
 * @footnote-ethics: medium - Action outcome routing changes user-visible response behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostChatRequest } from '@footnote/contracts/web';
import type { ChatPlan } from '../src/services/chatPlanner.js';
import { classifyPlanContinuation } from '../src/services/chatService/planContinuation.js';

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

const createPlan = (overrides: Partial<ChatPlan> = {}): ChatPlan => ({
    action: 'message',
    modality: 'text',
    safetyTier: 'Low',
    reasoning: 'reason',
    generation: {
        reasoningEffort: 'low',
        verbosity: 'low',
    },
    ...overrides,
});

test('classifyPlanContinuation returns continue_message for message actions', () => {
    const outcome = classifyPlanContinuation({
        executionPlan: createPlan(),
        normalizedRequest: createRequest(),
    });
    assert.equal(outcome.kind, 'continue_message');
});

test('classifyPlanContinuation returns terminal react action', () => {
    const outcome = classifyPlanContinuation({
        executionPlan: createPlan({ action: 'react', reaction: '🔥' }),
        normalizedRequest: createRequest(),
    });
    assert.equal(outcome.kind, 'terminal_action');
    if (outcome.kind !== 'terminal_action') {
        throw new Error('Expected terminal action');
    }
    assert.equal(outcome.terminalAction.responseAction, 'react');
    if (outcome.terminalAction.responseAction !== 'react') {
        throw new Error('Expected react response');
    }
    assert.equal(outcome.terminalAction.reaction, '🔥');
});

test('classifyPlanContinuation returns terminal ignore action', () => {
    const outcome = classifyPlanContinuation({
        executionPlan: createPlan({ action: 'ignore' }),
        normalizedRequest: createRequest(),
    });
    assert.equal(outcome.kind, 'terminal_action');
    if (outcome.kind !== 'terminal_action') {
        throw new Error('Expected terminal action');
    }
    assert.equal(outcome.terminalAction.responseAction, 'ignore');
});

test('classifyPlanContinuation returns terminal image action', () => {
    const outcome = classifyPlanContinuation({
        executionPlan: createPlan({
            action: 'image',
            imageRequest: {
                prompt: 'draw a skyline',
            },
        }),
        normalizedRequest: createRequest(),
    });
    assert.equal(outcome.kind, 'terminal_action');
    if (outcome.kind !== 'terminal_action') {
        throw new Error('Expected terminal action');
    }
    assert.equal(outcome.terminalAction.responseAction, 'image');
    if (outcome.terminalAction.responseAction !== 'image') {
        throw new Error('Expected image response');
    }
    assert.equal(outcome.terminalAction.imageRequest.prompt, 'draw a skyline');
});

test('classifyPlanContinuation fails open to ignore for image action without imageRequest', () => {
    const outcome = classifyPlanContinuation({
        executionPlan: createPlan({ action: 'image', imageRequest: undefined }),
        normalizedRequest: createRequest(),
    });
    assert.equal(outcome.kind, 'terminal_action');
    if (outcome.kind !== 'terminal_action') {
        throw new Error('Expected terminal action');
    }
    assert.equal(outcome.terminalAction.responseAction, 'ignore');
    assert.equal(outcome.fallbackReason, 'image_action_missing_image_request');
});
