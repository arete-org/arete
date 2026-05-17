/**
 * @description: Shared helpers for workflow-engine split tests.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineTestHelpers
 * @footnote-risk: low - Test helper drift can cause broad test breakage.
 * @footnote-ethics: low - Test utilities do not impact runtime governance behavior.
 */
import { runBoundedReviewWorkflow } from '../../src/services/workflowEngine.js';
import type { ConversationContextEnvelope } from '../../src/services/conversationContextService.js';

export const TEST_CONTEXT_ENVELOPE: ConversationContextEnvelope = {
    participants: [],
    turns: [],
    diagnostics: {
        surface: 'web',
        totalInputMessages: 0,
        projectedMessageCount: 0,
        trimmedMessageCount: 0,
        sanitizedTimestampCount: 0,
        projectedSpeakerLabelCount: 0,
    },
};

export const runBoundedReviewWorkflowForTest = (
    input: Omit<
        Parameters<typeof runBoundedReviewWorkflow>[0],
        'contextEnvelope'
    > & {
        contextEnvelope?: ConversationContextEnvelope;
    }
): ReturnType<typeof runBoundedReviewWorkflow> =>
    runBoundedReviewWorkflow({
        ...input,
        contextEnvelope: input.contextEnvelope ?? TEST_CONTEXT_ENVELOPE,
    });
