/**
 * @description: Normalizes incoming chat request shape and exposes shared
 * correlation/scope helpers used across orchestrator stages.
 * @footnote-scope: core
 * @footnote-module: ChatOrchestratorRequestNormalization
 * @footnote-risk: medium - Incorrect normalization or scope mapping can skew planner/generation context and trace joins.
 * @footnote-ethics: medium - Correlation and scope integrity impact auditability and governance interpretation.
 */
import type { CorrelationEnvelope } from '@footnote/contracts';
import type { PostChatRequest } from '@footnote/contracts/web';
import { normalizeDiscordConversation } from '../chatConversationNormalization.js';
import type { ScopeTuple } from '../executionContractTrustGraph/trustGraphEvidenceTypes.js';

const normalizeScopeValue = (value: string | undefined): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const normalizeRequest = (
    request: PostChatRequest,
    onWarn: { warn: (message: string, meta?: Record<string, unknown>) => void }
): {
    normalizedConversation: PostChatRequest['conversation'];
    normalizedRequest: PostChatRequest;
} => {
    const normalizedConversation =
        request.surface === 'discord'
            ? normalizeDiscordConversation(request, onWarn)
            : request.conversation.map(
                  (message: PostChatRequest['conversation'][number]) => ({
                      role: message.role,
                      content: message.content,
                  })
              );

    return {
        normalizedConversation,
        normalizedRequest: {
            ...request,
            conversation: normalizedConversation,
        },
    };
};

export const buildCorrelationIds = (
    request: PostChatRequest,
    responseId: string | null = null
): CorrelationEnvelope => ({
    conversationId: request.sessionId ?? null,
    requestId: request.trigger.messageId ?? null,
    incidentId: null,
    responseId,
});

export const buildExecutionContractScopeTuple = (
    request: PostChatRequest
): ScopeTuple | undefined => {
    const userId = normalizeScopeValue(request.surfaceContext?.userId);
    if (userId === undefined) {
        return undefined;
    }

    const channelProjectId = normalizeScopeValue(
        request.surfaceContext?.channelId
    );
    const guildCollectionId = normalizeScopeValue(
        request.surfaceContext?.guildId
    );

    if (channelProjectId !== undefined) {
        return {
            userId,
            projectId: channelProjectId,
        };
    }
    if (guildCollectionId !== undefined) {
        return {
            userId,
            collectionId: guildCollectionId,
        };
    }

    return { userId };
};
