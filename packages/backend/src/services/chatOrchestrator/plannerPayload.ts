/**
 * @description: Encapsulates planner payload shape and serialization used by
 * generation-time system instructions.
 * @footnote-scope: interface
 * @footnote-module: ChatOrchestratorPlannerPayload
 * @footnote-risk: medium - Payload schema drift can desync planner intent from generation behavior.
 * @footnote-ethics: medium - Planner payload clarity affects traceability of backend-owned decisions.
 */
import type { ChatPlan } from '../chatPlanner.js';
import type { ChatGenerationPlan } from '../chatGenerationTypes.js';

type PlannerWeatherFailureMarker = {
    failed: true;
    reason: 'weather_tool_failed';
};

/**
 * Planner generation payload after execution-time normalization.
 *
 * This stays close to `ChatGenerationPlan`, but it can carry a small amount of
 * transitional runtime context needed by prompt rendering.
 */
export type PlannerGenerationForPrompt = Omit<ChatGenerationPlan, 'weather'> & {
    weather?: ChatGenerationPlan['weather'] | PlannerWeatherFailureMarker;
};

/**
 * Planner decision payload serialized into generation prompts.
 *
 * This is a transport shape between backend stages, not a public API contract.
 */
export type PlannerPayloadChatPlan = Omit<ChatPlan, 'generation'> & {
    generation: PlannerGenerationForPrompt;
};

/**
 * Packs the normalized planner decision into one structured system payload.
 *
 * JSON keeps this payload machine-stable so generation can treat planner output
 * as data, not as ambiguous free-form text.
 */
export const buildPlannerPayload = (
    plan: PlannerPayloadChatPlan,
    surfacePolicy?: { coercedFrom: ChatPlan['action'] }
): string =>
    JSON.stringify({
        action: plan.action,
        modality: plan.modality,
        profileId: plan.profileId,
        requestedCapabilityProfile: plan.requestedCapabilityProfile,
        selectedCapabilityProfile: plan.selectedCapabilityProfile,
        reaction: plan.reaction,
        imageRequest: plan.imageRequest,
        safetyTier: plan.safetyTier,
        reasoning: plan.reasoning,
        generation: plan.generation,
        ...(surfacePolicy && { surfacePolicy }),
    });
