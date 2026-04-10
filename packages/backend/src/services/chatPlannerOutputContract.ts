/**
 * @description: Defines the canonical planner output contract surface and out-of-contract field detection used at ingestion boundaries.
 * @footnote-scope: core
 * @footnote-module: ChatPlannerOutputContract
 * @footnote-risk: high - Contract drift can blur planner intent with execution authority and change runtime behavior.
 * @footnote-ethics: high - Output contract integrity protects governance boundaries between planner suggestions and policy authority.
 */
import { chatRepoSearchHints } from '@footnote/contracts';
import { capabilityProfileIds } from './modelCapabilityPolicy.js';

export type PlannerOutputApplyOutcome =
    | 'accepted'
    | 'partially_applied'
    | 'rejected';

export type PlannerContractShapeName =
    | 'message'
    | 'react'
    | 'ignore'
    | 'image'
    | 'unknown';

export type PlannerContractAssessment = {
    shape: PlannerContractShapeName;
    outOfContractFields: string[];
    authorityFieldAttempts: string[];
};

type AllowedFieldTree = {
    [key: string]: AllowedFieldTree | true;
};

const PLANNER_ALLOWED_FIELD_TREE: AllowedFieldTree = {
    action: true,
    modality: true,
    requestedCapabilityProfile: true,
    contextNeed: true,
    contextTier: true,
    reaction: true,
    imageRequest: {
        prompt: true,
        aspectRatio: true,
        background: true,
        quality: true,
        style: true,
        allowPromptAdjustment: true,
        followUpResponseId: true,
        outputFormat: true,
        outputCompression: true,
    },
    safetyTier: true,
    reasoning: true,
    generation: {
        reasoningEffort: true,
        verbosity: true,
        temperament: {
            tightness: true,
            rationale: true,
            attribution: true,
            caution: true,
            extent: true,
        },
        search: {
            query: true,
            contextSize: true,
            intent: true,
            repoHints: true,
            topicHints: true,
        },
        weather: {
            location: {
                type: true,
                latitude: true,
                longitude: true,
                office: true,
                gridX: true,
                gridY: true,
            },
            horizonPeriods: true,
        },
    },
};

const AUTHORITY_FIELD_EXACT = new Set([
    'profileid',
    'selectedcapabilityprofile',
    'effectiveprofileid',
    'originalprofileid',
    'terminalauthority',
    'authoritylevel',
    'executioncontract',
    'policy',
    'policyid',
    'policyversion',
    'routing',
    'workflow',
    'workflowpolicy',
    'toolpolicy',
    'evaluator',
    'breaker',
    'reviewauthority',
]);

const AUTHORITY_FIELD_PATTERNS: RegExp[] = [
    /authority/i,
    /executioncontract/i,
    /workflow/i,
    /toolpolicy/i,
];

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isAuthorityField = (fieldPath: string): boolean => {
    const normalized = fieldPath
        .split('.')
        .pop()
        ?.replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase();
    if (!normalized) {
        return false;
    }
    if (AUTHORITY_FIELD_EXACT.has(normalized)) {
        return true;
    }
    return AUTHORITY_FIELD_PATTERNS.some((pattern) => pattern.test(fieldPath));
};

const collectOutOfContractFields = (
    value: Record<string, unknown>,
    allowedTree: AllowedFieldTree,
    pathPrefix: string,
    outOfContractFields: string[],
    authorityFieldAttempts: string[]
): void => {
    for (const [key, nestedValue] of Object.entries(value)) {
        const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        const allowedChild = allowedTree[key];
        if (!allowedChild) {
            outOfContractFields.push(childPath);
            if (isAuthorityField(childPath)) {
                authorityFieldAttempts.push(childPath);
            }
            continue;
        }

        if (allowedChild === true || !isPlainRecord(nestedValue)) {
            continue;
        }

        collectOutOfContractFields(
            nestedValue,
            allowedChild,
            childPath,
            outOfContractFields,
            authorityFieldAttempts
        );
    }
};

const dedupeValues = (values: string[]): string[] =>
    Array.from(new Set(values));

const resolvePlannerContractShape = (
    candidate: unknown
): PlannerContractShapeName => {
    if (!isPlainRecord(candidate)) {
        return 'unknown';
    }

    const action = candidate.action;
    if (
        action === 'message' ||
        action === 'react' ||
        action === 'ignore' ||
        action === 'image'
    ) {
        return action;
    }

    return 'unknown';
};

export const assessPlannerOutputContract = (
    candidate: unknown
): PlannerContractAssessment => {
    if (!isPlainRecord(candidate)) {
        return {
            shape: 'unknown',
            outOfContractFields: [],
            authorityFieldAttempts: [],
        };
    }

    const outOfContractFields: string[] = [];
    const authorityFieldAttempts: string[] = [];
    collectOutOfContractFields(
        candidate,
        PLANNER_ALLOWED_FIELD_TREE,
        '',
        outOfContractFields,
        authorityFieldAttempts
    );

    return {
        shape: resolvePlannerContractShape(candidate),
        outOfContractFields: dedupeValues(outOfContractFields),
        authorityFieldAttempts: dedupeValues(authorityFieldAttempts),
    };
};

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
