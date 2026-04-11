/**
 * @description: Defines the canonical planner decision contract used for structured planner tool calls.
 * @footnote-scope: core
 * @footnote-module: ChatPlannerDecisionContract
 * @footnote-risk: high - Contract drift here can break planner execution across providers.
 * @footnote-ethics: high - Planner contract integrity affects action choice, retrieval grounding, and user trust.
 */
import { chatPlannerDecisionParametersSchema } from './chatPlannerOutputContract.js';
import { projectPlannerSchemaForProvider } from './plannerSchemaAdapter.js';

export const CHAT_PLANNER_TOOL_NAME = 'submit_planner_decision';

/**
 * Planner tool descriptor used with OpenAI Responses function calling.
 */
export const chatPlannerDecisionTool = {
    type: 'function' as const,
    name: CHAT_PLANNER_TOOL_NAME,
    description:
        'Submit one planner decision object for the backend chat orchestrator.',
    strict: false,
    parameters: projectPlannerSchemaForProvider(
        chatPlannerDecisionParametersSchema
    ),
};
