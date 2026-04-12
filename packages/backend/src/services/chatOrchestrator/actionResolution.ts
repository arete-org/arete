/**
 * @description: Handles non-message planner actions and keeps early-return
 * branching out of the orchestration composition root.
 * @footnote-scope: core
 * @footnote-module: ChatOrchestratorActionResolution
 * @footnote-risk: medium - Action-branch mistakes can suppress valid replies or emit wrong surface behavior.
 * @footnote-ethics: medium - Wrong action routing changes user-visible outcomes and trust signals.
 */
import type {
    PostChatRequest,
    PostChatResponse,
} from '@footnote/contracts/web';
import type { ChatPlan } from '../chatPlanner.js';
import type {
    PlannerFallbackReason,
    PlannerSelectionSource,
} from '../plannerFallbackTelemetryRollup.js';

type ResolvePlannerActionInput = {
    executionPlan: ChatPlan;
    normalizedRequest: PostChatRequest;
    fallbackRollupSelectionSource: PlannerSelectionSource;
};

type ResolvePlannerActionRuntime = {
    fallbackReasons: PlannerFallbackReason[];
    emitFallbackRollup: (selectionSource: PlannerSelectionSource) => void;
    notifyBreakerEvent: (input: {
        responseId: string | null;
        responseAction: 'message' | 'ignore' | 'react' | 'image';
        responseModality: ChatPlan['modality'];
    }) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
};

export const resolveNonMessagePlannerAction = (
    input: ResolvePlannerActionInput,
    runtime: ResolvePlannerActionRuntime
): PostChatResponse | undefined => {
    // This helper only handles branches that return before text generation.
    // Message responses continue through the main orchestrator path because
    // they still need profile resolution, generation, and metadata assembly.
    if (input.executionPlan.action === 'ignore') {
        runtime.notifyBreakerEvent({
            responseId: null,
            responseAction: 'ignore',
            responseModality: input.executionPlan.modality,
        });
        runtime.emitFallbackRollup(input.fallbackRollupSelectionSource);
        return {
            action: 'ignore',
            metadata: null,
        };
    }

    if (input.executionPlan.action === 'react') {
        runtime.notifyBreakerEvent({
            responseId: null,
            responseAction: 'react',
            responseModality: input.executionPlan.modality,
        });
        runtime.emitFallbackRollup(input.fallbackRollupSelectionSource);
        return {
            action: 'react',
            reaction: input.executionPlan.reaction ?? '👍',
            metadata: null,
        };
    }

    if (
        input.executionPlan.action === 'image' &&
        input.executionPlan.imageRequest
    ) {
        runtime.notifyBreakerEvent({
            responseId: null,
            responseAction: 'image',
            responseModality: input.executionPlan.modality,
        });
        runtime.emitFallbackRollup(input.fallbackRollupSelectionSource);
        return {
            action: 'image',
            imageRequest: input.executionPlan.imageRequest,
            metadata: null,
        };
    }

    if (
        input.executionPlan.action === 'image' &&
        !input.executionPlan.imageRequest
    ) {
        // An image action without image instructions is not actionable.
        // Fall back to ignore instead of guessing at a prompt.
        runtime.fallbackReasons.push('image_action_missing_image_request');
        runtime.warn(
            `Chat planner returned image without imageRequest; falling back to ignore. surface=${input.normalizedRequest.surface} trigger=${input.normalizedRequest.trigger.kind} latestUserInputLength=${input.normalizedRequest.latestUserInput.length}`
        );
        runtime.notifyBreakerEvent({
            responseId: null,
            responseAction: 'ignore',
            responseModality: input.executionPlan.modality,
        });
        runtime.emitFallbackRollup(input.fallbackRollupSelectionSource);
        return {
            action: 'ignore',
            metadata: null,
        };
    }

    return undefined;
};
