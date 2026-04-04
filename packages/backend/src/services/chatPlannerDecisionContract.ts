/**
 * @description: Defines the canonical planner decision contract used for structured planner tool calls.
 * @footnote-scope: core
 * @footnote-module: ChatPlannerDecisionContract
 * @footnote-risk: high - Contract drift here can break planner execution across providers.
 * @footnote-ethics: high - Planner contract integrity affects action choice, retrieval grounding, and user trust.
 */
import { chatRepoSearchHints } from '@footnote/contracts';
import { capabilityProfileIds } from './modelCapabilityPolicy.js';
import { projectPlannerSchemaForProvider } from './plannerSchemaAdapter.js';

export const CHAT_PLANNER_TOOL_NAME = 'submit_planner_decision';

/**
 * Canonical JSON schema for planner decisions.
 * This is consumed by provider tool/function calling to force structured output.
 */
export const chatPlannerDecisionParametersSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
        action: {
            type: 'string',
            enum: ['message', 'react', 'ignore', 'image'],
        },
        modality: {
            type: 'string',
            enum: ['text', 'tts'],
        },
        requestedCapabilityProfile: {
            type: 'string',
            enum: capabilityProfileIds,
        },
        contextNeed: {
            type: 'string',
            enum: ['sufficient', 'needs_more_context'],
        },
        contextTier: {
            type: 'string',
            enum: [
                'current_window',
                'expanded_recent',
                'expanded_with_summary',
            ],
        },
        reaction: {
            type: 'string',
        },
        imageRequest: {
            type: 'object',
            additionalProperties: false,
            properties: {
                prompt: { type: 'string' },
                aspectRatio: {
                    type: 'string',
                    enum: ['auto', 'square', 'portrait', 'landscape'],
                },
                background: { type: 'string' },
                quality: {
                    type: 'string',
                    enum: ['low', 'medium', 'high', 'auto'],
                },
                style: { type: 'string' },
                allowPromptAdjustment: { type: 'boolean' },
                followUpResponseId: { type: 'string' },
                outputFormat: {
                    type: 'string',
                    enum: ['png', 'webp', 'jpeg'],
                },
                outputCompression: { type: 'number' },
            },
            required: ['prompt'],
        },
        safetyTier: {
            type: 'string',
            enum: ['Low', 'Medium', 'High'],
        },
        reasoning: {
            type: 'string',
        },
        generation: {
            type: 'object',
            additionalProperties: false,
            properties: {
                reasoningEffort: {
                    type: 'string',
                    enum: ['minimal', 'low', 'medium', 'high'],
                },
                verbosity: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                },
                temperament: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        tightness: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                        },
                        rationale: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                        },
                        attribution: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                        },
                        caution: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                        },
                        extent: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                        },
                    },
                    required: [
                        'tightness',
                        'rationale',
                        'attribution',
                        'caution',
                        'extent',
                    ],
                },
                search: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        query: { type: 'string' },
                        contextSize: {
                            type: 'string',
                            enum: ['low', 'medium', 'high'],
                        },
                        intent: {
                            type: 'string',
                            enum: ['repo_explainer', 'current_facts'],
                        },
                        repoHints: {
                            type: 'array',
                            items: {
                                type: 'string',
                                enum: chatRepoSearchHints,
                            },
                        },
                        topicHints: {
                            type: 'array',
                            maxItems: 5,
                            items: {
                                type: 'string',
                                minLength: 1,
                                maxLength: 40,
                            },
                        },
                    },
                    required: ['query', 'contextSize', 'intent'],
                },
                weather: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        location: {
                            oneOf: [
                                {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        type: {
                                            type: 'string',
                                            enum: ['lat_lon'],
                                        },
                                        latitude: { type: 'number' },
                                        longitude: { type: 'number' },
                                    },
                                    required: ['type', 'latitude', 'longitude'],
                                },
                                {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        type: {
                                            type: 'string',
                                            enum: ['gridpoint'],
                                        },
                                        office: { type: 'string' },
                                        gridX: {
                                            type: 'integer',
                                            minimum: 1,
                                        },
                                        gridY: {
                                            type: 'integer',
                                            minimum: 1,
                                        },
                                    },
                                    required: [
                                        'type',
                                        'office',
                                        'gridX',
                                        'gridY',
                                    ],
                                },
                            ],
                        },
                        horizonPeriods: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 12,
                        },
                    },
                    required: ['location'],
                },
            },
            required: ['reasoningEffort', 'verbosity'],
        },
    },
    required: ['action', 'modality', 'safetyTier', 'reasoning', 'generation'],
};

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
