/**
 * @description: Applies deterministic tool-selection policy before orchestration.
 * Tool selection is now unified through context integration - this policy is a no-op.
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
