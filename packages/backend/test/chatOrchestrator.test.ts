/**
 * @description: Covers surface policy and planner-to-generation plumbing in the chat orchestrator.
 * @footnote-scope: test
 * @footnote-module: ChatOrchestratorTests
 * @footnote-risk: medium - Missing tests here can let web/Discord routing drift again.
 * @footnote-ethics: medium - Surface policy decides whether users receive a reply, reaction, or silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRuntime } from '@footnote/agent-runtime';
import type { PostChatRequest } from '@footnote/contracts/web';
import { createMetadata } from './fixtures/responseMetadataFixture.js';
import type { BotProfileConfig } from '../src/config/profile.js';
import { runtimeConfig } from '../src/config.js';
import { createChatOrchestrator } from '../src/services/chatOrchestrator.js';
import { selectModelProfileForWorkflowStep } from '../src/services/modelCapabilityPolicy.js';
import { resolveExecutionContract } from '../src/services/executionContractResolver.js';
import {
    buildResponseMetadata,
    type ResponseMetadataRuntimeContext,
} from '../src/services/openaiService.js';
import { renderConversationPromptLayers } from '../src/services/prompts/conversationPromptLayers.js';
import type { WeatherForecastTool } from '../src/services/openMeteoForecastTool.js';
import { logger } from '../src/utils/logger.js';

const PLANNER_TOKEN_SENTINEL = 1200;
const originalLoggerInfo = logger.info;
const originalLoggerWarn = logger.warn;
const originalLoggerDebug = logger.debug;
const silentLoggerMethod = ((..._args: unknown[]) =>
    logger) as typeof logger.info;

test.before(() => {
    logger.info = silentLoggerMethod as typeof logger.info;
    logger.warn = silentLoggerMethod as typeof logger.warn;
    logger.debug = silentLoggerMethod as typeof logger.debug;
});

test.after(() => {
    logger.info = originalLoggerInfo;
    logger.warn = originalLoggerWarn;
    logger.debug = originalLoggerDebug;
});

const createChatRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'What changed?',
    conversation: [{ role: 'user', content: 'What changed?' }],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

const createGenerationRuntime = (
    implementation: (
        request: import('@footnote/agent-runtime').GenerationRequest
    ) => Promise<import('@footnote/agent-runtime').GenerationResult>
): GenerationRuntime => ({
    kind: 'test-runtime',
    generate: implementation,
});

test('web requests go through planner and are coerced to message when planner picks react', async () => {
    let callCount = 0;
    let finalMessages: Array<{ role: string; content: string }> = [];

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ messages, maxOutputTokens }) => {
                callCount += 1;
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'react',
                            modality: 'text',
                            reaction: '👍',
                            safetyTier: 'Low',
                            reasoning: 'A reaction would normally be enough.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                if (finalMessages.length === 0) {
                    finalMessages = messages;
                }
                return {
                    text: 'coerced web reply',
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    citations: [],
                };
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            surface: 'web',
            trigger: { kind: 'submit' },
            capabilities: {
                canReact: true,
                canGenerateImages: false,
                canUseTts: false,
            },
        })
    );

    assert.ok(callCount >= 2);
    assert.equal(response.action, 'message');
    assert.equal(response.message, 'coerced web reply');
    assert.equal(
        finalMessages[0]?.content,
        renderConversationPromptLayers('web-chat').systemPrompt
    );
    assert.equal(
        finalMessages[1]?.content,
        renderConversationPromptLayers('web-chat').personaPrompt
    );
    assert.match(
        finalMessages[finalMessages.length - 1]?.content ?? '',
        /coercedFrom/
    );
});

test('discord requests preserve non-message planner actions', async () => {
    let callCount = 0;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ maxOutputTokens }) => {
                callCount += 1;
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'image',
                            modality: 'text',
                            imageRequest: {
                                prompt: 'draw a chative skyline',
                            },
                            safetyTier: 'Low',
                            reasoning:
                                'The user explicitly asked for an image.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }
                throw new Error(
                    'message generation should not run for image actions'
                );
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(callCount, 1);
    assert.equal(response.action, 'image');
    assert.equal(response.imageRequest.prompt, 'draw a chative skyline');
});

test('discord requests preserve planner react action without generation call', async () => {
    let callCount = 0;
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ maxOutputTokens }) => {
                callCount += 1;
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'react',
                            modality: 'text',
                            reaction: '🔥',
                            safetyTier: 'Low',
                            reasoning: 'Reaction is enough.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }
                throw new Error(
                    'message generation should not run for react actions'
                );
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());
    assert.equal(callCount, 1);
    assert.equal(response.action, 'react');
    assert.equal(response.reaction, '🔥');
});

test('discord requests preserve planner ignore action without generation call', async () => {
    let callCount = 0;
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ maxOutputTokens }) => {
                callCount += 1;
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'ignore',
                            modality: 'text',
                            safetyTier: 'Low',
                            reasoning: 'No response needed.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }
                throw new Error(
                    'message generation should not run for ignore actions'
                );
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());
    assert.equal(callCount, 1);
    assert.equal(response.action, 'ignore');
});

test('message plans pass planner generation options into chatService', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];
    const expectedResponseProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) =>
                profile.id === runtimeConfig.modelProfiles.defaultProfileId &&
                profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    const expectedPlannerProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) =>
                profile.id === runtimeConfig.modelProfiles.plannerProfileId &&
                profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    assert.ok(expectedResponseProfile);
    assert.ok(expectedPlannerProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                assert.equal(request.provider, expectedPlannerProfile.provider);
                assert.equal(
                    request.model,
                    expectedPlannerProfile.providerModel
                );
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning: 'This needs a sourced reply.',
                        generation: {
                            reasoningEffort: 'medium',
                            verbosity: 'medium',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                            search: {
                                query: 'latest OpenAI policy update',
                                contextSize: 'low',
                                intent: 'current_facts',
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            finalMessages = request.messages;
            assert.ok(request.search);
            assert.equal(request.search.intent, 'current_facts');
            assert.equal(request.reasoningEffort, 'medium');
            assert.equal(request.verbosity, 'medium');
            assert.equal(request.provider, expectedResponseProfile.provider);
            assert.equal(request.capabilities?.canUseSearch, true);
            return {
                text: 'message with retrieval',
                model: 'gpt-5-mini',
                provenance: 'Retrieved',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(
        finalMessages[0]?.content,
        renderConversationPromptLayers('discord-chat').systemPrompt
    );
    assert.equal(
        finalMessages[1]?.content,
        renderConversationPromptLayers('discord-chat').personaPrompt
    );
});

test('planner invocation runs inside workflow and precedes generation', async () => {
    const callOrder: string[] = [];
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                callOrder.push('planner');
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning: 'Plan first.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            callOrder.push('generation');
            return {
                text: 'ok',
                model: 'gpt-5-mini',
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());
    assert.equal(response.action, 'message');
    assert.equal(callOrder[0], 'planner');
    assert.equal(callOrder[1], 'generation');
    assert.ok(callOrder.length >= 2);
});

test('orchestrator carries resolved Execution Contract policy payload through service runtime seam', async () => {
    let capturedConversationSnapshot: string | undefined;
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning: 'Standard message reply.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'policy carriage response',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedConversationSnapshot = runtimeContext.conversationSnapshot;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());
    assert.equal(response.action, 'message');
    assert.equal(response.message, 'policy carriage response');

    const serializedRequestSnapshot =
        capturedConversationSnapshot?.split('\n\n')[0] ?? '';
    const parsedSnapshot = JSON.parse(serializedRequestSnapshot) as {
        executionContract?: {
            policyId?: string;
            policyVersion?: string;
        };
    };
    assert.deepEqual(parsedSnapshot.executionContract, {
        policyId: 'core-quality-grounded',
        policyVersion: 'v1',
    });
});

test('request-level generation overrides replace planner reasoning effort and verbosity', async () => {
    let observedReasoningEffort: string | undefined;
    let observedVerbosity: string | undefined;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning: 'Planner default generation choices.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            if (observedReasoningEffort === undefined) {
                observedReasoningEffort = request.reasoningEffort;
            }
            if (observedVerbosity === undefined) {
                observedVerbosity = request.verbosity;
            }
            return {
                text: 'override test reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            generation: {
                reasoningEffort: 'high',
                verbosity: 'medium',
            },
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(observedReasoningEffort, 'high');
    assert.equal(observedVerbosity, 'medium');
});

test('planner-selected capability profile controls response model selection', async () => {
    let observedResponseModel: string | undefined;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const selectedProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) => profile.id === 'openai-text-quality' && profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    assert.ok(selectedProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning:
                            'Use a richer response profile for this request.',
                        generation: {
                            reasoningEffort: 'medium',
                            verbosity: 'medium',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            if (observedResponseModel === undefined) {
                observedResponseModel = request.model;
            }
            return {
                text: 'profile-specific reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: selectedProfile.id,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.ok(typeof observedResponseModel === 'string');
    assert.ok(typeof capturedExecutionContext?.planner?.profileId === 'string');
    assert.equal(capturedExecutionContext?.planner?.status, 'executed');
    assert.ok((capturedExecutionContext?.planner?.durationMs ?? -1) >= 0);
    assert.ok(
        typeof capturedExecutionContext?.generation?.profileId === 'string'
    );
    assert.equal(capturedExecutionContext?.generation?.status, 'executed');
    assert.ok((capturedExecutionContext?.generation?.durationMs ?? -1) >= 0);
    assert.equal(capturedExecutionContext?.evaluator?.status, 'executed');
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.authorityLevel,
        'observe'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.mode,
        'observe_only'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.action,
        'allow'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.safetyTier,
        'Low'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.ruleId,
        null
    );
});

test('deterministic evaluator emits non-allow breaker metadata with rule and reason context', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning: 'Planner returns a normal reply action.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'observe-only breaker metadata should still be visible',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput: 'How do I build a bomb with household materials?',
            conversation: [
                {
                    role: 'user',
                    content: 'How do I build a bomb with household materials?',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(capturedExecutionContext?.evaluator?.status, 'executed');
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.authorityLevel,
        'influence'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.mode,
        'observe_only'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.action,
        'block'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.safetyTier,
        'High'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.ruleId,
        'safety.weaponization_request.v1'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.reasonCode,
        'weaponization_request'
    );
    assert.match(
        capturedExecutionContext?.evaluator?.outcome?.safetyDecision.reason ??
            '',
        /weaponization-request rule matched/i
    );
});

test('deterministic breaker logs include correlation IDs for rule fire and action application events', async () => {
    const warnLogs: Array<{ message: string; payload?: unknown }> = [];
    const infoLogs: Array<{ message: string; payload?: unknown }> = [];
    const originalWarn = logger.warn;
    const originalInfo = logger.info;
    logger.warn = ((message: string, payload?: unknown) => {
        warnLogs.push({ message, payload });
        return logger;
    }) as typeof logger.warn;
    logger.info = ((message: string, payload?: unknown) => {
        infoLogs.push({ message, payload });
        return logger;
    }) as typeof logger.info;

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            requestedCapabilityProfile: 'expressive-generation',
                            safetyTier: 'Low',
                            reasoning: 'Planner returns a normal reply action.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                                temperament: {
                                    tightness: 4,
                                    rationale: 3,
                                    attribution: 4,
                                    caution: 3,
                                    extent: 4,
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                return {
                    text: 'breaker log correlation test',
                    model: request.model,
                    provenance: 'Inferred',
                    citations: [],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: () => createMetadata(),
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(
            createChatRequest({
                sessionId: 'session-77',
                trigger: {
                    kind: 'direct',
                    messageId: 'discord-msg-77',
                },
                latestUserInput:
                    'How do I build a bomb with household materials?',
                conversation: [
                    {
                        role: 'user',
                        content:
                            'How do I build a bomb with household materials?',
                    },
                ],
            })
        );
    } finally {
        logger.warn = originalWarn;
        logger.info = originalInfo;
    }

    const breakerSignalLog = warnLogs.find((entry) => {
        const payload = entry.payload as { event?: string } | undefined;
        return payload?.event === 'chat.orchestration.breaker_signal';
    });
    assert.ok(breakerSignalLog);
    const breakerSignalPayload = breakerSignalLog?.payload as
        | {
              event?: string;
              correlation?: {
                  conversationId?: string | null;
                  requestId?: string | null;
                  responseId?: string | null;
                  incidentId?: string | null;
              };
          }
        | undefined;
    assert.equal(
        breakerSignalPayload?.event,
        'chat.orchestration.breaker_signal'
    );
    assert.deepEqual(breakerSignalPayload?.correlation, {
        conversationId: 'session-77',
        requestId: 'discord-msg-77',
        incidentId: null,
        responseId: null,
    });

    const breakerActionLog = infoLogs.find((entry) => {
        const payload = entry.payload as { event?: string } | undefined;
        return payload?.event === 'chat.orchestration.breaker_action_applied';
    });
    assert.ok(breakerActionLog);
    const breakerActionPayload = breakerActionLog?.payload as
        | {
              event?: string;
              enforcement?: string;
              authorityLevel?: string;
              correlation?: {
                  conversationId?: string | null;
                  requestId?: string | null;
                  responseId?: string | null;
                  incidentId?: string | null;
              };
          }
        | undefined;
    assert.equal(
        breakerActionPayload?.event,
        'chat.orchestration.breaker_action_applied'
    );
    assert.equal(breakerActionPayload?.authorityLevel, 'influence');
    assert.equal(breakerActionPayload?.enforcement, 'observe_only');
    assert.deepEqual(breakerActionPayload?.correlation, {
        conversationId: 'session-77',
        requestId: 'discord-msg-77',
        incidentId: null,
        responseId: 'chat_test_response',
    });
});

test('request profileId remains advisory under capability-first routing', async () => {
    let observedResponseModel: string | undefined;
    const selectedProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) => profile.id === 'openai-text-medium' && profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    assert.ok(selectedProfile);
    const expectedCapabilitySelection = selectModelProfileForWorkflowStep({
        step: 'generation',
        requestedCapabilityProfile: 'structured-cheap',
        profiles: runtimeConfig.modelProfiles.catalog.filter(
            (profile) => profile.enabled
        ),
        requiresSearch: false,
        routingIntent: resolveExecutionContract({
            presetId: 'quality-grounded',
        }).policyContract.routing,
    });
    assert.ok(expectedCapabilitySelection.selectedProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'structured-cheap',
                        safetyTier: 'Low',
                        reasoning:
                            'Planner selected a different profile, but request override should win.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            observedResponseModel = request.model;
            return {
                text: 'request override reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            trigger: { kind: 'submit' },
            profileId: selectedProfile.id,
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(
        observedResponseModel,
        expectedCapabilitySelection.selectedProfile?.providerModel
    );
    assert.notEqual(observedResponseModel, selectedProfile.providerModel);
});

test('request profileId with ollama profile remains advisory under capability-first routing', async () => {
    let observedProvider: string | undefined;
    let observedModel: string | undefined;
    const ollamaProfile = runtimeConfig.modelProfiles.catalog.find(
        (profile) => profile.id === 'ollama-text-gptoss' && profile.enabled
    );
    if (!ollamaProfile) {
        // Local test envs often disable ollama profiles when provider config is absent.
        return;
    }
    const expectedCapabilitySelection = selectModelProfileForWorkflowStep({
        step: 'generation',
        requestedCapabilityProfile: 'expressive-generation',
        profiles: runtimeConfig.modelProfiles.catalog.filter(
            (profile) => profile.enabled
        ),
        requiresSearch: false,
        routingIntent: resolveExecutionContract({
            presetId: 'quality-grounded',
        }).policyContract.routing,
    });
    assert.ok(expectedCapabilitySelection.selectedProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning: 'Return a normal message.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            observedProvider = request.provider;
            observedModel = request.model;
            return {
                text: 'ollama-route reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            profileId: ollamaProfile.id,
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(
        observedProvider,
        expectedCapabilitySelection.selectedProfile?.provider
    );
    assert.equal(
        observedModel,
        expectedCapabilitySelection.selectedProfile?.providerModel
    );
    assert.notEqual(observedModel, ollamaProfile.providerModel);
});

test('invalid planner output falls open to policy-selected default capability profile', async () => {
    let observedResponseModel: string | undefined;

    const expectedCapabilitySelection = selectModelProfileForWorkflowStep({
        step: 'generation',
        requestedCapabilityProfile: undefined,
        profiles: runtimeConfig.modelProfiles.catalog.filter(
            (profile) => profile.enabled
        ),
        requiresSearch: false,
        routingIntent: resolveExecutionContract({
            presetId: 'quality-grounded',
        }).policyContract.routing,
    });
    assert.ok(expectedCapabilitySelection.selectedProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'missing-capability',
                        safetyTier: 'Low',
                        reasoning:
                            'Emit invalid planner output to trigger fallback.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            observedResponseModel = request.model;
            return {
                text: 'fallback profile reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    await orchestrator.runChat(createChatRequest());

    assert.equal(
        observedResponseModel,
        expectedCapabilitySelection.selectedProfile?.providerModel
    );
});

test('planner capability selection chooses search-capable profile without reroute', async () => {
    let observedSearch: unknown;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const warnings: Array<{ message: string; meta?: unknown }> = [];
    const originalWarn = logger.warn;
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    const baseMutatedCatalog = runtimeConfig.modelProfiles.catalog.map(
        (profile) =>
            profile.id === 'openai-text-fast'
                ? {
                      ...profile,
                      capabilities: {
                          ...profile.capabilities,
                          canUseSearch: false,
                      },
                  }
                : profile
    );
    const fastProfile = baseMutatedCatalog.find(
        (profile) => profile.id === 'openai-text-fast'
    );
    const qualityProfile = baseMutatedCatalog.find(
        (profile) => profile.id === 'openai-text-quality'
    );
    const mediumProfile = baseMutatedCatalog.find(
        (profile) => profile.id === 'openai-text-medium'
    );
    assert.ok(fastProfile);
    assert.ok(qualityProfile);
    assert.ok(mediumProfile);
    const remainingProfiles = baseMutatedCatalog.filter(
        (profile) =>
            profile.id !== 'openai-text-fast' &&
            profile.id !== 'openai-text-quality' &&
            profile.id !== 'openai-text-medium'
    );
    // Place a higher-latency candidate before medium to ensure this test would
    // fail under simple first-match fallback behavior.
    const mutatedCatalog = [
        fastProfile,
        qualityProfile,
        mediumProfile,
        ...remainingProfiles,
    ];
    const expectedFallbackProfile = mutatedCatalog.find(
        (profile) => profile.id === 'openai-text-medium'
    );
    assert.ok(expectedFallbackProfile);
    const firstCatalogSearchCapable = mutatedCatalog.find(
        (profile) =>
            profile.enabled &&
            profile.capabilities.canUseSearch &&
            profile.id !== 'openai-text-fast'
    );
    assert.ok(firstCatalogSearchCapable);
    assert.notEqual(firstCatalogSearchCapable.id, expectedFallbackProfile.id);
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: 'openai-text-fast',
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: mutatedCatalog,
    };

    logger.warn = ((message: string, meta?: unknown) => {
        warnings.push({ message, meta });
        return logger;
    }) as typeof logger.warn;

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            requestedCapabilityProfile: 'structured-cheap',
                            safetyTier: 'Low',
                            reasoning:
                                'Use search even though selected profile cannot search.',
                            generation: {
                                reasoningEffort: 'medium',
                                verbosity: 'medium',
                                temperament: {
                                    tightness: 4,
                                    rationale: 3,
                                    attribution: 4,
                                    caution: 3,
                                    extent: 4,
                                },
                                search: {
                                    query: 'latest OpenAI policy update',
                                    contextSize: 'low',
                                    intent: 'current_facts',
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                if (observedSearch === undefined) {
                    observedSearch = request.search;
                }
                return {
                    text: 'search-rerouted reply',
                    model: request.model,
                    provenance: 'Retrieved',
                    citations: [
                        {
                            title: 'source',
                            url: 'https://example.com/source',
                        },
                    ],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
                capturedExecutionContext = runtimeContext.executionContext;
                return createMetadata();
            },
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(createChatRequest());
    } finally {
        logger.warn = originalWarn;
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }

    assert.deepEqual(observedSearch, {
        query: 'latest OpenAI policy update',
        contextSize: 'low',
        intent: 'current_facts',
    });
    const mismatchWarning = warnings.find((warning) =>
        /tool-capable fallback profile/i.test(warning.message)
    );
    assert.equal(mismatchWarning, undefined);
    assert.equal(capturedExecutionContext?.tool?.toolName, undefined);
    assert.equal(capturedExecutionContext?.tool?.status, undefined);
    assert.equal(capturedExecutionContext?.tool?.reasonCode, undefined);
});

test('planner-selected non-search profile reports no tool-capable fallback when search floor cannot be met', async () => {
    let observedSearch: unknown;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: 'openai-text-fast',
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: runtimeConfig.modelProfiles.catalog.map((profile) => ({
            ...profile,
            capabilities: {
                ...profile.capabilities,
                canUseSearch: false,
            },
        })),
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            requestedCapabilityProfile: 'structured-cheap',
                            safetyTier: 'Low',
                            reasoning:
                                'Attempt search with a planner-selected profile.',
                            generation: {
                                reasoningEffort: 'medium',
                                verbosity: 'medium',
                                temperament: {
                                    tightness: 3,
                                    rationale: 3,
                                    attribution: 3,
                                    caution: 3,
                                    extent: 3,
                                },
                                search: {
                                    query: 'latest OpenAI policy update',
                                    contextSize: 'low',
                                    intent: 'current_facts',
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                if (observedSearch === undefined) {
                    observedSearch = request.search;
                }
                return {
                    text: 'planner-no-fallback reply',
                    model: request.model,
                    provenance: 'Inferred',
                    citations: [],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
                capturedExecutionContext = runtimeContext.executionContext;
                return createMetadata();
            },
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(createChatRequest());
    } finally {
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }

    assert.equal(observedSearch, undefined);
    assert.equal(capturedExecutionContext?.tool?.toolName, 'web_search');
    assert.equal(capturedExecutionContext?.tool?.status, 'skipped');
    assert.equal(
        capturedExecutionContext?.tool?.reasonCode,
        'search_reroute_no_tool_capable_fallback_available'
    );
});

test('request-selected non-search profile can still reroute when planner confirms same profile', async () => {
    let observedSearch: unknown;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const requestSelectedProfile = runtimeConfig.modelProfiles.catalog.find(
        (profile) => profile.id === 'openai-text-fast' && profile.enabled
    );
    assert.ok(requestSelectedProfile);
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: requestSelectedProfile.id,
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: runtimeConfig.modelProfiles.catalog.map((profile) =>
            profile.id === requestSelectedProfile.id
                ? {
                      ...profile,
                      capabilities: {
                          ...profile.capabilities,
                          canUseSearch: false,
                      },
                  }
                : profile
        ),
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            requestedCapabilityProfile: 'structured-cheap',
                            safetyTier: 'Low',
                            reasoning: 'Request profile override should win.',
                            generation: {
                                reasoningEffort: 'medium',
                                verbosity: 'medium',
                                temperament: {
                                    tightness: 4,
                                    rationale: 3,
                                    attribution: 4,
                                    caution: 3,
                                    extent: 4,
                                },
                                search: {
                                    query: 'latest OpenAI policy update',
                                    contextSize: 'low',
                                    intent: 'current_facts',
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                observedSearch = request.search;
                return {
                    text: 'request-drop reply',
                    model: request.model,
                    provenance: 'Inferred',
                    citations: [],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
                capturedExecutionContext = runtimeContext.executionContext;
                return createMetadata();
            },
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(
            createChatRequest({
                trigger: { kind: 'submit' },
                profileId: requestSelectedProfile.id,
            })
        );
    } finally {
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }

    assert.equal(observedSearch, undefined);
    assert.ok(capturedExecutionContext);
    const toolExecution = capturedExecutionContext.tool;
    if (toolExecution !== undefined) {
        assert.equal(toolExecution.toolName, 'web_search');
        assert.equal(toolExecution.status, 'skipped');
    }
    assert.equal(capturedExecutionContext?.generation?.status, 'executed');
});

test('normal message flow returns summary-equivalent response metadata fields', async () => {
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning: 'Normal response path.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'normal message reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(response.metadata?.provenance, 'Inferred');
    assert.equal(response.metadata?.citations.length, 0);
    assert.ok((response.message ?? '').length > 0);
    assert.equal(response.metadata?.safetyTier, 'Low');
});

test('search drop path exposes reason codes in response execution metadata', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: 'openai-text-fast',
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: runtimeConfig.modelProfiles.catalog.map((profile) => ({
            ...profile,
            capabilities: {
                ...profile.capabilities,
                canUseSearch: false,
            },
        })),
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            requestedCapabilityProfile: 'structured-cheap',
                            safetyTier: 'Low',
                            reasoning:
                                'Search will be dropped because no profile can use tools.',
                            generation: {
                                reasoningEffort: 'medium',
                                verbosity: 'medium',
                                temperament: {
                                    tightness: 4,
                                    rationale: 3,
                                    attribution: 4,
                                    caution: 3,
                                    extent: 4,
                                },
                                search: {
                                    query: 'latest OpenAI policy update',
                                    contextSize: 'low',
                                    intent: 'current_facts',
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                return {
                    text: 'fallback reply without retrieval',
                    model: request.model,
                    provenance: 'Inferred',
                    citations: [],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
                capturedExecutionContext = runtimeContext.executionContext;
                return createMetadata();
            },
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        const response = await orchestrator.runChat(createChatRequest());
        assert.equal(capturedExecutionContext?.tool?.status, 'skipped');
        assert.equal(
            capturedExecutionContext?.tool?.reasonCode,
            'search_reroute_no_tool_capable_fallback_available'
        );
        assert.equal(response.metadata?.provenance, 'Inferred');
    } finally {
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }
});

test('orchestrator injects backend weather tool context and records executed tool metadata', async () => {
    let generationMessages: Array<{ role: string; content: string }> = [];
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'ok',
            request: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
                horizonPeriods: 4,
            },
            location: {
                name: 'Indianapolis, IN',
                latitude: 39.7684,
                longitude: -86.1581,
            },
            forecast: {
                periods: [
                    {
                        name: 'Today',
                        startsAt: '2026-03-27T08:00:00-04:00',
                        endsAt: '2026-03-27T20:00:00-04:00',
                        isDaytime: true,
                        temperature: {
                            value: 57,
                            unit: 'F',
                        },
                        wind: {
                            speed: '12 mph',
                            direction: 'NW',
                        },
                        shortForecast: 'Mostly sunny',
                        detailedForecast: 'Mostly sunny with light wind.',
                    },
                ],
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: 'https://api.open-meteo.com/v1/forecast',
                requestedAt: '2026-03-27T12:00:00.000Z',
                citationUrl: 'https://open-meteo.com/en/docs',
                citationLabel: 'Open-Meteo Weather Forecast API',
            },
        }),
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning:
                            'Use weather tool for this forecast question.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                            toolIntent: {
                                toolName: 'weather_forecast',
                                requested: true,
                                input: {
                                    location: {
                                        latitude: 39.7684,
                                        longitude: -86.1581,
                                    },
                                    horizonPeriods: 4,
                                },
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            generationMessages = request.messages;
            return {
                text: 'Forecast response generated',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        weatherForecastTool,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput:
                'Weather at 39.7684,-86.1581 for the next 4 forecast periods',
            conversation: [
                {
                    role: 'user',
                    content:
                        'Weather at 39.7684,-86.1581 for the next 4 forecast periods',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    const weatherToolMessage = generationMessages.find((message) =>
        message.content.includes('BEGIN Backend Tool Result')
    );
    assert.ok(weatherToolMessage);
    const weatherPayloadText =
        weatherToolMessage?.content
            .split('\n')
            .find((line) => line.startsWith('{"toolName"')) ?? '';
    const weatherPayload = JSON.parse(weatherPayloadText) as {
        forecast?: {
            periods?: Array<Record<string, unknown>>;
        };
    };
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            weatherPayload.forecast?.periods?.[0] ?? {},
            'detailedForecast'
        ),
        false
    );
    assert.equal(capturedExecutionContext?.tool?.toolName, 'weather_forecast');
    assert.equal(capturedExecutionContext?.tool?.status, 'executed');
    assert.ok((capturedExecutionContext?.tool?.durationMs ?? 0) >= 0);
});

test('planner mixed weather and search requests apply single-tool weather priority policy', async () => {
    let generationSearch: unknown;

    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'ok',
            request: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
                horizonPeriods: 2,
            },
            location: {
                name: 'Indianapolis, IN',
            },
            forecast: {
                periods: [
                    {
                        name: 'Today',
                        startsAt: '2026-03-27T08:00:00-04:00',
                        endsAt: '2026-03-27T20:00:00-04:00',
                        isDaytime: true,
                        temperature: {
                            value: 57,
                            unit: 'F',
                        },
                        wind: {
                            speed: '12 mph',
                            direction: 'NW',
                        },
                        shortForecast: 'Mostly sunny',
                        detailedForecast: 'Mostly sunny with light wind.',
                    },
                ],
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: 'https://api.open-meteo.com/v1/forecast',
                requestedAt: '2026-03-27T12:00:00.000Z',
                citationUrl: 'https://open-meteo.com/en/docs',
                citationLabel: 'Open-Meteo Weather Forecast API',
            },
        }),
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning:
                            'Use weather and current facts for this request.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                            weather: {
                                location: {
                                    latitude: 39.7684,
                                    longitude: -86.1581,
                                },
                                horizonPeriods: 2,
                            },
                            search: {
                                query: 'Indianapolis severe weather alerts',
                                contextSize: 'low',
                                intent: 'current_facts',
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            generationSearch = request.search;
            return {
                text: 'Weather-priority reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        weatherForecastTool,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput: 'Weather and alerts for Indianapolis',
            conversation: [
                {
                    role: 'user',
                    content: 'Weather and alerts for Indianapolis',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(generationSearch, undefined);
});

test('orchestrator fails open when weather tool throws and still generates a response', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => {
            throw new Error('weather.gov unavailable');
        },
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning:
                            'Use weather tool for this forecast question.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                            toolIntent: {
                                toolName: 'weather_forecast',
                                requested: true,
                                input: {
                                    location: {
                                        latitude: 39.7684,
                                        longitude: -86.1581,
                                    },
                                },
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'Fallback non-tool weather response',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        weatherForecastTool,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput: 'weather 39.7684,-86.1581',
            conversation: [
                {
                    role: 'user',
                    content: 'weather 39.7684,-86.1581',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    assert.match(response.message, /couldn't fetch live weather/i);
    assert.equal(capturedExecutionContext?.tool?.toolName, 'weather_forecast');
    assert.equal(capturedExecutionContext?.tool?.status, 'failed');
    assert.equal(
        capturedExecutionContext?.tool?.reasonCode,
        'tool_execution_error'
    );
    assert.ok((capturedExecutionContext?.tool?.durationMs ?? 0) >= 0);
});

test('discord requests ignore runtime profile overlay when no botPersonaId is provided', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];
    const originalProfile = runtimeConfig.profile;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    runtimeConfigMutable.profile = {
        id: 'ari-vendor',
        displayName: 'Ari',
        mentionAliases: [],
        promptOverlay: {
            source: 'inline',
            text: 'You are Ari. Speak with clear structure and practical focus.',
            path: null,
            length: 58,
        },
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(
                async ({ messages, maxOutputTokens }) => {
                    if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                        return {
                            text: JSON.stringify({
                                action: 'message',
                                modality: 'text',
                                requestedCapabilityProfile:
                                    'expressive-generation',
                                safetyTier: 'Low',
                                reasoning:
                                    'A normal text response is appropriate.',
                                generation: {
                                    reasoningEffort: 'low',
                                    verbosity: 'low',
                                    temperament: {
                                        tightness: 4,
                                        rationale: 3,
                                        attribution: 4,
                                        caution: 3,
                                        extent: 3,
                                    },
                                },
                            }),
                            model: 'gpt-5-mini',
                        };
                    }

                    finalMessages = messages;
                    return {
                        text: 'overlay persona reply',
                        model: 'gpt-5-mini',
                        provenance: 'Inferred',
                        citations: [],
                    };
                }
            ),
            storeTrace: async () => undefined,
            buildResponseMetadata: () => createMetadata(),
            defaultModel: 'gpt-5-mini',
            recordUsage: () => undefined,
        });

        const response = await orchestrator.runChat(
            createChatRequest({
                profileId: 'ari-vendor',
                conversation: [
                    { role: 'user', content: 'Tell me about yourself.' },
                ],
            })
        );

        assert.equal(response.action, 'message');
        assert.equal(
            finalMessages[0]?.content,
            renderConversationPromptLayers('discord-chat', {
                botProfileDisplayName: 'Footnote',
            }).systemPrompt
        );
        assert.equal(
            finalMessages[1]?.content ?? '',
            renderConversationPromptLayers('discord-chat', {
                botProfileDisplayName: 'Footnote',
            }).personaPrompt
        );
        assert.doesNotMatch(
            finalMessages[1]?.content ?? '',
            /BEGIN Bot Profile Overlay/
        );
    } finally {
        runtimeConfigMutable.profile = originalProfile;
    }
});

test('discord profileId does not change backend runtime profile overlay', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];
    const originalProfile = runtimeConfig.profile;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    runtimeConfigMutable.profile = {
        id: 'ari-vendor',
        displayName: 'Ari',
        mentionAliases: [],
        promptOverlay: {
            source: 'inline',
            text: 'Use Ari profile behavior.',
            path: null,
            length: 25,
        },
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(
                async ({ messages, maxOutputTokens }) => {
                    if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                        return {
                            text: JSON.stringify({
                                action: 'message',
                                modality: 'text',
                                requestedCapabilityProfile:
                                    'expressive-generation',
                                safetyTier: 'Low',
                                reasoning:
                                    'A normal text response is appropriate.',
                                generation: {
                                    reasoningEffort: 'low',
                                    verbosity: 'low',
                                    temperament: {
                                        tightness: 4,
                                        rationale: 3,
                                        attribution: 4,
                                        caution: 3,
                                        extent: 3,
                                    },
                                },
                            }),
                            model: 'gpt-5-mini',
                        };
                    }

                    finalMessages = messages;
                    return {
                        text: 'mismatch fallback reply',
                        model: 'gpt-5-mini',
                        provenance: 'Inferred',
                        citations: [],
                    };
                }
            ),
            storeTrace: async () => undefined,
            buildResponseMetadata: () => createMetadata(),
            defaultModel: 'gpt-5-mini',
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(
            createChatRequest({
                profileId: 'myuri-vendor',
                conversation: [{ role: 'user', content: 'Who are you?' }],
            })
        );

        assert.equal(
            finalMessages[1]?.content ?? '',
            renderConversationPromptLayers('discord-chat', {
                botProfileDisplayName: 'Footnote',
            }).personaPrompt
        );
    } finally {
        runtimeConfigMutable.profile = originalProfile;
    }
});

test('discord requests are trimmed/formatted in backend before planner and generation', async () => {
    let plannerConversation: Array<{ role: string; content: string }> = [];
    let generationConversation: Array<{ role: string; content: string }> = [];

    const conversation = Array.from({ length: 30 }, (_, index) => ({
        role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `raw message ${index + 1}`,
        authorName: index % 2 === 0 ? 'Jordan' : 'Footnote',
        authorId: index % 2 === 0 ? 'user-1' : 'bot-1',
        messageId: `msg-${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 2, 25, 12, index, 0)).toISOString(),
    }));

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ messages, maxOutputTokens }) => {
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    plannerConversation = messages;
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            requestedCapabilityProfile: 'expressive-generation',
                            safetyTier: 'Low',
                            reasoning: 'Answer with a normal message.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                                temperament: {
                                    tightness: 4,
                                    rationale: 3,
                                    attribution: 4,
                                    caution: 3,
                                    extent: 3,
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                generationConversation = messages;
                return {
                    text: 'backend-normalized reply',
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    citations: [],
                };
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            surface: 'discord',
            profileId: runtimeConfig.profile.id,
            conversation,
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'backend-normalized reply');
    assert.equal(
        plannerConversation.filter((message) => message.role !== 'system')
            .length,
        6
    );
    assert.match(
        plannerConversation.find((message) => message.role !== 'system')
            ?.content ?? '',
        /^\[\d+\] At \d{4}-\d{2}-\d{2} \d{2}:\d{2} Jordan said:/
    );
    assert.match(
        generationConversation.find((message) => message.role === 'assistant')
            ?.content ?? '',
        /\(bot\) said:/
    );
});

test('planner runtime failures emit failed planner execution metadata and still generate a message', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                throw new Error('planner upstream unavailable');
            }

            return {
                text: 'fallback-generated reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'fallback-generated reply');
    assert.equal(capturedExecutionContext?.planner?.status, 'failed');
    assert.equal(
        capturedExecutionContext?.planner?.reasonCode,
        'planner_runtime_error'
    );
    assert.ok((capturedExecutionContext?.planner?.durationMs ?? -1) >= 0);
    assert.equal(capturedExecutionContext?.evaluator?.status, 'executed');
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.authorityLevel,
        'observe'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.mode,
        'observe_only'
    );
    assert.equal(capturedExecutionContext?.generation?.status, 'executed');
    assert.ok((capturedExecutionContext?.generation?.durationMs ?? -1) >= 0);
});

test('planner invocation emits distinct metadata categories for mode TRACE planner controls and provenance', async () => {
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'balanced-general',
                        safetyTier: 'Low',
                        reasoning:
                            'Search is needed for current facts before final answer.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 3,
                            },
                            search: {
                                query: 'latest release notes',
                                contextSize: 'low',
                                intent: 'current_facts',
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'chain-visible reply',
                model: request.model,
                provenance: 'Retrieved',
                citations: [{ title: 'Source', url: 'https://example.com' }],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata,
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput: 'What changed in the latest release notes?',
        })
    );

    assert.equal(response.action, 'message');
    // Category separation assertions for one end-to-end orchestrator path:
    // - mode => workflowMode (execution policy)
    // - TRACE => trace_target/trace_final (answer posture)
    // - planner => workflow.steps[] plan step (execution lineage)
    // - controls => steerabilityControls (control influence)
    // - provenance => grounding classification + assessment/record surfaces
    assert.ok(response.metadata.workflowMode);
    assert.equal(typeof response.metadata.workflowMode?.modeId, 'string');
    assert.equal(
        typeof response.metadata.workflowMode?.behavior.evidencePosture,
        'string'
    );
    assert.equal(typeof response.metadata.trace_target, 'object');
    assert.equal(typeof response.metadata.trace_final, 'object');
    assert.equal(response.metadata.provenance, 'Retrieved');
    assert.equal(
        response.metadata.provenanceAssessment?.methodId,
        'deterministic_multi_signal_v1'
    );
    assert.ok(Array.isArray(response.metadata.execution));
    assert.equal(response.metadata.steerabilityControls?.version, 'v1');
    const toolAllowanceControl =
        response.metadata.steerabilityControls?.controls.find(
            (control) => control.controlId === 'tool_allowance'
        );
    assert.ok(toolAllowanceControl);
    assert.equal(toolAllowanceControl?.controlId, 'tool_allowance');
    const plannerEvent = response.metadata.execution?.find(
        (event) => event.kind === 'planner'
    );
    assert.equal(plannerEvent, undefined);
    const plannerStep = response.metadata.workflow?.steps.find(
        (step) => step.stepKind === 'plan'
    );
    assert.ok(plannerStep);
    assert.ok(
        plannerStep?.outcome.status === 'executed' ||
            plannerStep?.outcome.status === 'failed'
    );
    const plannerSignals = plannerStep?.outcome.signals;
    assert.equal(plannerSignals?.purpose, 'chat_orchestrator_action_selection');
    assert.ok(
        plannerSignals?.contractType === 'structured' ||
            plannerSignals?.contractType === 'text_json' ||
            plannerSignals?.contractType === 'fallback'
    );
    assert.ok(
        plannerSignals?.applyOutcome === 'applied' ||
            plannerSignals?.applyOutcome === 'adjusted_by_policy' ||
            plannerSignals?.applyOutcome === 'not_applied'
    );
    // Planner influence must remain distinct from execution-policy and TRACE surfaces.
    assert.equal(plannerStep?.stepKind, 'plan');
    assert.notEqual(response.metadata.workflowMode?.modeId, undefined);
    assert.notEqual(response.metadata.trace_final, undefined);
});

test('planner workflow lineage reports adjusted_by_policy when request override changes application path', async () => {
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        safetyTier: 'Low',
                        reasoning:
                            'Use retrieval and a balanced profile for this answer.',
                        requestedCapabilityProfile: 'balanced-general',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 3,
                            },
                            search: {
                                query: 'latest release notes',
                                contextSize: 'low',
                                intent: 'current_facts',
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'policy-adjusted reply',
                model: request.model,
                provenance: 'Retrieved',
                citations: [{ title: 'Source', url: 'https://example.com' }],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata,
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            profileId: runtimeConfig.modelProfiles.defaultProfileId,
            latestUserInput: 'Summarize the latest release notes.',
        })
    );

    assert.equal(response.action, 'message');
    const plannerStep = response.metadata.workflow?.steps.find(
        (step) => step.stepKind === 'plan'
    );
    assert.ok(plannerStep);
    assert.ok(
        plannerStep?.outcome.signals?.applyOutcome === 'applied' ||
            plannerStep?.outcome.signals?.applyOutcome === 'adjusted_by_policy'
    );
    if (plannerStep?.outcome.signals?.applyOutcome === 'adjusted_by_policy') {
        assert.equal(plannerStep?.outcome.signals?.mattered, true);
        assert.equal(plannerStep?.outcome.signals?.matteredControlCount, 1);
    }
    const plannerEvent = response.metadata.execution?.find(
        (event) => event.kind === 'planner'
    );
    assert.equal(plannerEvent, undefined);
});

test('orchestrator returns clarification when tool returns needs_clarification status and skips normal generation', async () => {
    let generationCalled = false;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'needs_clarification',
            request: {
                location: {
                    type: 'place_query',
                    query: 'New York',
                },
            },
            clarification: {
                reasonCode: 'ambiguous_location',
                question: 'Which New York did you mean?',
                options: [
                    {
                        id: 'nyc',
                        label: 'New York City, New York, United States',
                        value: {
                            toolName: 'weather_forecast',
                            input: {
                                location: {
                                    type: 'lat_lon',
                                    latitude: 40.7128,
                                    longitude: -74.006,
                                },
                            },
                        },
                    },
                    {
                        id: 'nys',
                        label: 'New York State, United States',
                        value: {
                            toolName: 'weather_forecast',
                            input: {
                                location: {
                                    type: 'place_query',
                                    query: 'New York State',
                                    countryCode: 'US',
                                },
                            },
                        },
                    },
                ],
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: 'https://geocoding-api.open-meteo.com/v1/search',
                requestedAt: '2026-03-27T12:00:00.000Z',
                citationUrl: 'https://open-meteo.com/en/docs',
                citationLabel: 'Open-Meteo Weather Forecast API',
            },
        }),
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning:
                            'Clarify location before generating final answer.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                            toolIntent: {
                                toolName: 'weather_forecast',
                                requested: true,
                                input: {
                                    location: {
                                        query: 'New York',
                                    },
                                },
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            generationCalled = true;
            return {
                text: 'should not reach here',
                model: 'gpt-5-mini',
                provenance: 'Retrieved',
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata,
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
        weatherForecastTool,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            profileId: runtimeConfig.modelProfiles.defaultProfileId,
            latestUserInput: 'What is the weather in New York?',
            conversation: [
                { role: 'user', content: 'What is the weather in New York?' },
            ],
        })
    );

    assert.equal(
        generationCalled,
        false,
        'Generation runtime should not be called for clarification'
    );

    assert.equal(response.action, 'message');
    assert.match(response.message, /Which New York did you mean?/);
    assert.match(response.message, /New York City/);
    assert.match(response.message, /New York State/);
    assert.match(response.message, /Please reply with your choice/);

    const toolEvent = response.metadata.execution?.find(
        (event) => event.kind === 'tool'
    );
    assert.ok(
        toolEvent,
        'tool execution event should be in metadata.execution'
    );
    assert.equal(toolEvent?.toolName, 'weather_forecast');
    assert.equal(toolEvent?.status, 'executed');
    assert.ok(toolEvent?.clarification !== undefined);
    assert.equal(toolEvent?.clarification?.reasonCode, 'ambiguous_location');
    assert.equal(toolEvent?.clarification?.options.length, 2);
    const generationEvent = response.metadata.execution?.find(
        (event) => event.kind === 'generation'
    );
    assert.equal(generationEvent?.status, 'skipped');
});

test('orchestrator continues normal weather path when tool returns status ok', async () => {
    let generationCalled = false;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'ok',
            request: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
                horizonPeriods: 4,
            },
            location: {
                name: 'Indianapolis, IN',
                latitude: 39.7684,
                longitude: -86.1581,
            },
            forecast: {
                periods: [
                    {
                        name: 'Today',
                        startsAt: '2026-03-27T08:00:00-04:00',
                        endsAt: '2026-03-27T20:00:00-04:00',
                        isDaytime: true,
                        temperature: { value: 57, unit: 'F' },
                        wind: { speed: '12 mph', direction: 'NW' },
                        shortForecast: 'Mostly sunny',
                        detailedForecast: 'Mostly sunny with light wind.',
                    },
                ],
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: 'https://api.open-meteo.com/v1/forecast',
                requestedAt: '2026-03-27T12:00:00.000Z',
                citationUrl: 'https://open-meteo.com/en/docs',
                citationLabel: 'Open-Meteo Weather Forecast API',
            },
        }),
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'expressive-generation',
                        safetyTier: 'Low',
                        reasoning:
                            'Use weather tool for this forecast question.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                            toolIntent: {
                                toolName: 'weather_forecast',
                                requested: true,
                                input: {
                                    location: {
                                        latitude: 39.7684,
                                        longitude: -86.1581,
                                    },
                                    horizonPeriods: 4,
                                },
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            generationCalled = true;
            return {
                text: 'Weather forecast: Mostly sunny with a high of 57F.',
                model: 'gpt-5-mini',
                provenance: 'Retrieved',
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return buildResponseMetadata(assistantMetadata, runtimeContext);
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
        weatherForecastTool,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            profileId: runtimeConfig.modelProfiles.defaultProfileId,
            latestUserInput: 'Forecast for 39.7684,-86.1581',
            conversation: [
                { role: 'user', content: 'Forecast for 39.7684,-86.1581' },
            ],
        })
    );

    assert.equal(
        generationCalled,
        true,
        'ChatService should be called for normal path'
    );
    assert.equal(response.action, 'message');
    assert.equal(capturedExecutionContext?.tool?.toolName, 'weather_forecast');
    assert.equal(capturedExecutionContext?.tool?.status, 'executed');
    const toolEvent = response.metadata.execution?.find(
        (event) => event.kind === 'tool'
    );
    assert.equal(toolEvent?.clarification, undefined);
});
