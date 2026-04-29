/**
 * @description: Applies deterministic tool-selection policy before orchestration.
 * TEMPORARY: This is a no-op while tool selection is handled by the backend registry.
 * TODO: Delete this file once context integration owns tool adapter arbitration.
 *       Tool selection will then be handled by the context-integration execution layer.
 * @footnote-scope: core
 * @footnote-module: ChatToolPolicy
 * @footnote-risk: low - Policy no-op since unified tool intent replaces weather/search branching.
 * @footnote-ethics: low - Tool selection now flows through unified context integration path.
 */
import type { ChatGenerationPlan } from '../chatGenerationTypes.js';
import type { ToolPolicyLogEvent } from './toolTypes.js';

export type ToolPolicyDecision = {
    generation: ChatGenerationPlan;
    logEvent?: ToolPolicyLogEvent;
};

export const applySingleToolPolicy = (
    generation: ChatGenerationPlan
): ToolPolicyDecision => {
    return { generation };
};
