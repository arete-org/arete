/**
 * @description: Covers the VoltAgent-backed generation runtime adapter.
 * @footnote-scope: test
 * @footnote-module: VoltAgentRuntimeTests
 * @footnote-risk: medium - Missing tests here could let the new runtime drift on model mapping, fallback behavior, or usage normalization before cutover.
 * @footnote-ethics: medium - This adapter needs to preserve sourcing and transparency expectations while VoltAgent is still an alternate implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '@voltagent/core';
import type { GenerationRequest, RuntimeMessage } from '../src/index.js';
import {
    createDefaultVoltAgentExecutor,
    createVoltAgentRuntime,
    type VoltAgentGenerateTextOptions,
    type VoltAgentLogger,
} from '../src/voltagentRuntime.js';

test('voltagent runtime maps transcript and generation settings into executor options', async () => {
    let seenModel: string | undefined;
    let seenMessages: RuntimeMessage[] | undefined;
    let seenOptions: VoltAgentGenerateTextOptions | undefined;
    const signal = new AbortController().signal;
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        createExecutor: ({ model }) => {
            seenModel = model;

            return {
                async generateText(messages, options) {
                    seenMessages = messages;
                    seenOptions = options;

                    return {
                        text: 'voltagent reply',
                        response: {
                            modelId: model,
                        },
                    };
                },
            };
        },
    });
    const request: GenerationRequest = {
        messages: [{ role: 'user', content: 'Summarize the repo changes.' }],
        model: 'gpt-5.1',
        maxOutputTokens: 800,
        reasoningEffort: 'minimal',
        verbosity: 'high',
        signal,
    };

    const result = await runtime.generate(request);

    assert.equal(seenModel, 'openai/gpt-5.1');
    assert.deepEqual(seenMessages, request.messages);
    assert.equal(seenOptions?.maxOutputTokens, 800);
    assert.equal(seenOptions?.signal, signal);
    assert.deepEqual(seenOptions?.providerOptions, {
        reasoningEffort: 'low',
        verbosity: 'high',
    });
    assert.equal(result.text, 'voltagent reply');
    assert.equal(result.model, 'gpt-5.1');
});

test('voltagent runtime prefixes model with requested provider when model id is provider-local', async () => {
    let seenModel: string | undefined;
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        createExecutor: ({ model }) => {
            seenModel = model;
            return {
                async generateText() {
                    return {
                        text: 'provider-routed reply',
                        response: {
                            modelId: model,
                        },
                    };
                },
            };
        },
    });

    const result = await runtime.generate({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        model: 'claude-3-5-sonnet',
        provider: 'openai',
    });

    assert.equal(seenModel, 'openai/claude-3-5-sonnet');
    assert.equal(result.model, 'claude-3-5-sonnet');
});

test('voltagent runtime resolves model tiers through adapter-owned configuration', async () => {
    let seenModel: string | undefined;
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        modelTiers: {
            'text-fast': 'openai/gpt-5-mini',
            'text-quality': 'openai/gpt-5.1',
        },
        createExecutor: ({ model }) => {
            seenModel = model;
            return {
                async generateText() {
                    return {
                        text: 'tiered reply',
                        response: {
                            modelId: model,
                        },
                    };
                },
            };
        },
    });

    const result = await runtime.generate({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        model: 'text-quality',
    });

    assert.equal(seenModel, 'openai/gpt-5.1');
    assert.equal(result.model, 'gpt-5.1');
});

test('voltagent runtime logs tier fallback when requested alias is not configured', async () => {
    let seenModel: string | undefined;
    let seenWarning:
        | {
              message: string;
              context: object | undefined;
          }
        | undefined;
    const logger: VoltAgentLogger = {
        trace() {},
        debug() {},
        info() {},
        warn(message, context) {
            seenWarning = { message, context };
        },
        error() {},
        fatal() {},
        child() {
            return this;
        },
    };
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        modelTiers: {
            'text-fast': 'openai/gpt-5-mini',
        },
        logger,
        createExecutor: ({ model }) => {
            seenModel = model;
            return {
                async generateText() {
                    return {
                        text: 'fallback reply',
                        response: {
                            modelId: model,
                        },
                    };
                },
            };
        },
    });

    const result = await runtime.generate({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        model: 'text-quality',
    });

    assert.equal(seenModel, 'openai/gpt-5-mini');
    assert.equal(result.model, 'gpt-5-mini');
    assert.equal(
        seenWarning?.message,
        'VoltAgent tier alias was not configured; falling back to defaultModel.'
    );
    assert.deepEqual(seenWarning?.context, {
        requestedModel: 'text-quality',
        resolvedModel: 'gpt-5-mini',
        missingTierAlias: 'text-quality',
        configuredTierAliases: ['text-fast'],
    });
});

test('voltagent runtime normalizes non-search output into GenerationResult', async () => {
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        createExecutor: () => ({
            async generateText() {
                return {
                    text: 'normalized VoltAgent reply',
                    finishReason: 'stop',
                    usage: {
                        promptTokens: 90,
                        completionTokens: 45,
                        totalTokens: 135,
                    },
                    response: {
                        modelId: 'openai/gpt-5.2',
                    },
                };
            },
        }),
    });

    const result = await runtime.generate({
        messages: [
            { role: 'user', content: 'Explain the current runtime seam.' },
        ],
        model: 'gpt-5-mini',
    });

    assert.equal(result.text, 'normalized VoltAgent reply');
    assert.equal(result.model, 'gpt-5.2');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, {
        promptTokens: 90,
        completionTokens: 45,
        totalTokens: 135,
    });
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.retrieval, {
        requested: false,
        used: false,
    });
    assert.equal(result.provenance, 'Inferred');
});

test('voltagent runtime executes search requests through the VoltAgent executor', async () => {
    let seenOptions: VoltAgentGenerateTextOptions | undefined;
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        createExecutor: () => ({
            async generateText(_messages, options) {
                seenOptions = options;

                return {
                    text: 'search-backed reply',
                    sources: [
                        {
                            title: 'Latest Policy Update',
                            url: 'https://example.com/policy',
                        },
                    ],
                    response: {
                        modelId: 'openai/gpt-5-mini',
                        body: {
                            output: [{ type: 'web_search_call' }],
                        },
                    },
                };
            },
        }),
    });
    const request: GenerationRequest = {
        messages: [
            { role: 'user', content: 'Find the latest policy changes.' },
        ],
        capabilities: {
            canUseSearch: true,
        },
        search: {
            query: 'latest policy changes',
            contextSize: 'low',
            intent: 'current_facts',
        },
    };

    const result = await runtime.generate(request);

    assert.deepEqual(seenOptions?.search, {
        query: 'latest policy changes',
        contextSize: 'low',
        intent: 'current_facts',
    });
    assert.equal(result.text, 'search-backed reply');
    assert.deepEqual(result.citations, [
        {
            title: 'Latest Policy Update',
            url: 'https://example.com/policy',
        },
    ]);
    assert.deepEqual(result.retrieval, {
        requested: true,
        used: true,
    });
    assert.equal(result.provenance, 'Retrieved');
});

test('voltagent runtime omits openai-only options for ollama models', async () => {
    let seenOptions: VoltAgentGenerateTextOptions | undefined;
    const runtime = createVoltAgentRuntime({
        defaultModel: 'ollama/llama3.2:3b',
        createExecutor: () => ({
            async generateText(_messages, options) {
                seenOptions = options;
                return {
                    text: 'ollama reply',
                    response: {
                        modelId: 'ollama/llama3.2:3b',
                    },
                };
            },
        }),
    });

    await runtime.generate({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        model: 'ollama/llama3.2:3b',
        reasoningEffort: 'high',
        verbosity: 'high',
        search: {
            query: 'latest release notes',
            contextSize: 'high',
            intent: 'current_facts',
        },
    });

    assert.equal(seenOptions?.providerOptions, undefined);
    assert.equal(seenOptions?.search, undefined);
});

test('voltagent runtime does not forward search for providers without a mapped search tool', async () => {
    let seenOptions: VoltAgentGenerateTextOptions | undefined;
    const runtime = createVoltAgentRuntime({
        defaultModel: 'ollama/llama3.2:3b',
        createExecutor: () => ({
            async generateText(_messages, options) {
                seenOptions = options;
                return {
                    text: 'capability-enabled search reply',
                    response: {
                        modelId: 'ollama/llama3.2:3b',
                    },
                };
            },
        }),
    });

    await runtime.generate({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        model: 'ollama/llama3.2:3b',
        search: {
            query: 'latest release notes',
            contextSize: 'high',
            intent: 'current_facts',
        },
        capabilities: {
            canUseSearch: true,
        },
    });

    assert.equal(seenOptions?.search, undefined);
});

test('voltagent runtime maps remote ollama provider to ollama-cloud and normalizes cloud base URL', async () => {
    let seenModel: string | undefined;
    const originalOllamaCloudBaseUrl = process.env.OLLAMA_CLOUD_BASE_URL;
    const originalOllamaApiKey = process.env.OLLAMA_API_KEY;

    try {
        const runtime = createVoltAgentRuntime({
            defaultModel: 'gpt-oss:20b-cloud',
            ollama: {
                baseUrl: 'https://ollama.com/api',
                apiKey: 'test-ollama-key',
                localInferenceEnabled: false,
            },
            createExecutor: ({ model }) => {
                seenModel = model;
                return {
                    async generateText() {
                        return {
                            text: 'cloud ollama reply',
                            response: {
                                modelId: model,
                            },
                        };
                    },
                };
            },
        });

        const result = await runtime.generate({
            messages: [{ role: 'user', content: 'Summarize this.' }],
            model: 'gpt-oss:20b-cloud',
            provider: 'ollama',
        });

        assert.equal(seenModel, 'ollama-cloud/gpt-oss:20b-cloud');
        assert.equal(result.model, 'gpt-oss:20b-cloud');
        assert.equal(
            process.env.OLLAMA_CLOUD_BASE_URL,
            'https://ollama.com/v1'
        );
        assert.equal(process.env.OLLAMA_API_KEY, 'test-ollama-key');
    } finally {
        if (originalOllamaCloudBaseUrl === undefined) {
            delete process.env.OLLAMA_CLOUD_BASE_URL;
        } else {
            process.env.OLLAMA_CLOUD_BASE_URL = originalOllamaCloudBaseUrl;
        }
        if (originalOllamaApiKey === undefined) {
            delete process.env.OLLAMA_API_KEY;
        } else {
            process.env.OLLAMA_API_KEY = originalOllamaApiKey;
        }
    }
});

test('voltagent runtime recovers markdown-link citations when retrieved output lacks structured sources', async () => {
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        createExecutor: () => ({
            async generateText() {
                return {
                    text: 'Recent headlines: [1](https://example.com/a) [Policy Blog](https://example.com/b)',
                    response: {
                        modelId: 'openai/gpt-5-mini',
                        body: {
                            output: [{ type: 'web_search_call' }],
                        },
                    },
                };
            },
        }),
    });

    const result = await runtime.generate({
        messages: [{ role: 'user', content: 'What changed today?' }],
        capabilities: {
            canUseSearch: true,
        },
        search: {
            query: 'latest changes today',
            contextSize: 'low',
            intent: 'current_facts',
        },
    });

    assert.deepEqual(result.citations, [
        { title: 'Source', url: 'https://example.com/a' },
        { title: 'Policy Blog', url: 'https://example.com/b' },
    ]);
    assert.equal(result.provenance, 'Retrieved');
});

test('voltagent runtime ignores malformed bracket-heavy markdown without falling back or hanging', async () => {
    const runtime = createVoltAgentRuntime({
        defaultModel: 'gpt-5-mini',
        createExecutor: () => ({
            async generateText() {
                return {
                    text: `${'[!](http://'.repeat(200)} not a real citation`,
                    response: {
                        modelId: 'openai/gpt-5-mini',
                        body: {
                            output: [{ type: 'web_search_call' }],
                        },
                    },
                };
            },
        }),
    });

    const result = await runtime.generate({
        messages: [{ role: 'user', content: 'What changed today?' }],
        capabilities: {
            canUseSearch: true,
        },
        search: {
            query: 'latest changes today',
            contextSize: 'low',
            intent: 'current_facts',
        },
    });

    assert.deepEqual(result.citations, []);
    assert.equal(result.provenance, 'Retrieved');
});

test('voltagent runtime requires a request model or configured default model', async () => {
    const runtime = createVoltAgentRuntime({
        createExecutor: () => ({
            async generateText() {
                return {
                    text: 'unexpected',
                };
            },
        }),
    });

    await assert.rejects(
        () =>
            runtime.generate({
                messages: [{ role: 'user', content: 'Hello there.' }],
            }),
        /VoltAgent runtime requires request\.model or a configured defaultModel\./
    );
});

test('default VoltAgent executor maps usage from the installed AI SDK token fields', async () => {
    const fakeAgent = {
        generateText: async (
            ..._args: Parameters<Agent['generateText']>
        ): Promise<Awaited<ReturnType<Agent['generateText']>>> => ({
            content: [],
            text: 'executor reply',
            reasoning: [],
            reasoningText: undefined,
            files: [],
            sources: [],
            toolCalls: [],
            staticToolCalls: [],
            dynamicToolCalls: [],
            toolResults: [],
            staticToolResults: [],
            dynamicToolResults: [],
            finishReason: 'stop',
            rawFinishReason: 'stop',
            usage: {
                inputTokens: 21,
                inputTokenDetails: {
                    noCacheTokens: 21,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
                outputTokens: 9,
                outputTokenDetails: {
                    textTokens: 9,
                    reasoningTokens: 0,
                },
                totalTokens: 30,
            },
            totalUsage: {
                inputTokens: 21,
                inputTokenDetails: {
                    noCacheTokens: 21,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
                outputTokens: 9,
                outputTokenDetails: {
                    textTokens: 9,
                    reasoningTokens: 0,
                },
                totalTokens: 30,
            },
            warnings: undefined,
            request: {},
            response: {
                modelId: 'openai/gpt-5-mini',
                id: 'response_1',
                timestamp: new Date(0),
                messages: [],
            },
            providerMetadata: undefined,
            steps: [],
            experimental_output: undefined,
            output: undefined,
            context: new Map(),
            feedback: null,
        }),
    } satisfies Pick<Agent, 'generateText'>;
    const executor = createDefaultVoltAgentExecutor({
        model: 'openai/gpt-5-mini',
        agentFactory: () => fakeAgent,
    });

    const result = await executor.generateText(
        [{ role: 'user', content: 'Summarize the change.' }],
        {}
    );

    assert.deepEqual(result.usage, {
        promptTokens: 21,
        completionTokens: 9,
        totalTokens: 30,
    });
});

test('default VoltAgent executor passes the configured logger into Agent creation', async () => {
    const seenLoggers: VoltAgentLogger[] = [];
    const logger: VoltAgentLogger = {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
            return this;
        },
    };
    const executor = createDefaultVoltAgentExecutor({
        model: 'openai/gpt-5-mini',
        logger,
        agentFactory: ({ logger: agentLogger }) => {
            if (agentLogger) {
                seenLoggers.push(agentLogger);
            }

            const fakeAgent = {
                generateText: async (
                    ..._args: Parameters<Agent['generateText']>
                ): Promise<Awaited<ReturnType<Agent['generateText']>>> => ({
                    content: [],
                    text: 'executor reply',
                    reasoning: [],
                    reasoningText: undefined,
                    files: [],
                    sources: [],
                    toolCalls: [],
                    staticToolCalls: [],
                    dynamicToolCalls: [],
                    toolResults: [],
                    staticToolResults: [],
                    dynamicToolResults: [],
                    finishReason: 'stop',
                    rawFinishReason: 'stop',
                    usage: {
                        inputTokens: 0,
                        inputTokenDetails: {
                            noCacheTokens: 0,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0,
                        },
                        outputTokens: 0,
                        outputTokenDetails: {
                            textTokens: 0,
                            reasoningTokens: 0,
                        },
                        totalTokens: 0,
                    },
                    totalUsage: {
                        inputTokens: 0,
                        inputTokenDetails: {
                            noCacheTokens: 0,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0,
                        },
                        outputTokens: 0,
                        outputTokenDetails: {
                            textTokens: 0,
                            reasoningTokens: 0,
                        },
                        totalTokens: 0,
                    },
                    warnings: undefined,
                    request: {},
                    response: {
                        modelId: 'openai/gpt-5-mini',
                        id: 'response_1',
                        timestamp: new Date(0),
                        messages: [],
                    },
                    providerMetadata: undefined,
                    steps: [],
                    experimental_output: undefined,
                    output: undefined,
                    context: new Map(),
                    feedback: null,
                }),
            } satisfies Pick<Agent, 'generateText'>;

            return fakeAgent;
        },
    });

    await executor.generateText([{ role: 'user', content: 'Ping' }], {});

    assert.deepEqual(seenLoggers, [logger]);
});
