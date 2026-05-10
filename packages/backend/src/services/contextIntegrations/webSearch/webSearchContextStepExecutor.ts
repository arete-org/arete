/**
 * @description: Web-search context-step executor orchestrating provider fallback and normalized output.
 * @footnote-scope: core
 * @footnote-module: WebSearchContextStepExecutor
 * @footnote-risk: medium - Provider-fallback orchestration affects grounding coverage and failure handling.
 * @footnote-ethics: medium - Search metadata and status mapping affect user-visible transparency.
 */
import type { ToolInvocationReasonCode } from '@footnote/contracts/policy';
import {
    buildExecutedContextStepResult,
    buildFailedContextStepResult,
    buildSkippedContextStepResult,
} from '../contextStepExecution.js';
import type {
    ContextStepExecutor,
    ContextStepResult,
} from '../../workflowEngine.js';
import {
    normalizeCitation,
    parseWebSearchInput,
} from './webSearchNormalization.js';
import {
    formatContextMessages,
    buildSearchHints,
} from './webSearchPromptFormatting.js';
import { buildWebSearchProviderRegistry } from './webSearchProviders.js';
import type {
    WebSearchContextStepIntegrationPayload,
    WebSearchHint,
    WebSearchProviderAttempt,
    WebSearchProviderName,
    WebSearchRecord,
} from './webSearchTypes.js';

type WebSearchProviderAttemptStatus = WebSearchProviderAttempt['status'];

const createAttemptRecorder = (attempts: WebSearchProviderAttempt[]) => ({
    push: (input: {
        provider: WebSearchProviderName;
        status: WebSearchProviderAttemptStatus;
        durationMs: number;
        resultCount: number;
        reasonCode?: ToolInvocationReasonCode;
    }): void => {
        attempts.push({
            provider: input.provider,
            status: input.status,
            ...(input.reasonCode !== undefined && {
                reasonCode: input.reasonCode,
            }),
            durationMs: input.durationMs,
            resultCount: input.resultCount,
        });
    },
    skipped: (provider: WebSearchProviderName): void => {
        attempts.push({
            provider,
            status: 'skipped',
            reasonCode: 'tool_unavailable',
            durationMs: 0,
            resultCount: 0,
        });
    },
    failed: (
        provider: WebSearchProviderName,
        reasonCode: ToolInvocationReasonCode,
        durationMs: number
    ): void => {
        attempts.push({
            provider,
            status: 'failed',
            reasonCode,
            durationMs,
            resultCount: 0,
        });
    },
    completed: (
        provider: WebSearchProviderName,
        records: WebSearchRecord[],
        durationMs: number
    ): void => {
        attempts.push({
            provider,
            status:
                records.length > 0 ? 'executed_with_results' : 'executed_empty',
            durationMs,
            resultCount: records.length,
        });
    },
});

export const createWebSearchContextStepExecutor = ({
    enabled,
    providerPriority,
    searxngBaseUrl,
    braveApiKey,
    serpApiKey,
    serpApiEngine,
    serpApiGl,
    serpApiHl,
    providerTimeoutMs,
    maxResults,
    onWarn,
}: {
    enabled: boolean;
    providerPriority: WebSearchProviderName[];
    searxngBaseUrl: string | null;
    braveApiKey: string | null;
    serpApiKey: string | null;
    serpApiEngine: string | null;
    serpApiGl: string | null;
    serpApiHl: string | null;
    providerTimeoutMs: number;
    maxResults: number;
    onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): ContextStepExecutor => {
    const warn = onWarn ?? (() => undefined);
    const providerRegistry = buildWebSearchProviderRegistry({
        searxngBaseUrl,
        braveApiKey,
        serpApiKey,
        serpApiEngine,
        serpApiGl,
        serpApiHl,
    });
    return async ({ request }): Promise<ContextStepResult> => {
        if (!enabled) {
            return buildSkippedContextStepResult({
                toolName: request.integrationName,
                reasonCode: 'tool_unavailable',
            });
        }
        if (!request.requested) {
            return buildSkippedContextStepResult({
                toolName: request.integrationName,
                reasonCode: request.reasonCode ?? 'tool_not_requested',
            });
        }
        if (!request.eligible) {
            return buildSkippedContextStepResult({
                toolName: request.integrationName,
                reasonCode: request.reasonCode ?? 'unspecified_tool_outcome',
            });
        }
        const input = parseWebSearchInput(request.input);
        if (!input) {
            return buildFailedContextStepResult({
                toolName: request.integrationName,
                reasonCode: 'unspecified_tool_outcome',
            });
        }

        const attempts: WebSearchProviderAttempt[] = [];
        const attemptRecorder = createAttemptRecorder(attempts);
        const startedAt = Date.now();
        let discovered: WebSearchRecord[] = [];
        for (const provider of providerPriority) {
            const providerStartedAt = Date.now();
            const registryEntry = providerRegistry[provider];
            if (!registryEntry) {
                attemptRecorder.push({
                    provider,
                    status: 'skipped',
                    reasonCode: 'tool_unavailable',
                    durationMs: 0,
                    resultCount: 0,
                });
                continue;
            }
            if (!registryEntry.isConfigured()) {
                attemptRecorder.skipped(provider);
                continue;
            }
            const result = await registryEntry.run({
                query: input.query,
                timeoutMs: providerTimeoutMs,
                maxResults,
            });
            const durationMs = Math.max(0, Date.now() - providerStartedAt);
            if (!result.ok) {
                attemptRecorder.failed(provider, result.reasonCode, durationMs);
                continue;
            }
            attemptRecorder.completed(provider, result.records, durationMs);
            if (result.records.length > 0) {
                discovered = result.records;
                break;
            }
        }

        const durationMs = Math.max(0, Date.now() - startedAt);
        const searchHints: WebSearchHint[] = buildSearchHints(input);
        if (discovered.length === 0) {
            warn('web_search context integration completed without results', {
                attempts,
                query: input.query,
            });
            if (attempts.every((attempt) => attempt.status === 'skipped')) {
                return {
                    executionContext: {
                        toolName: request.integrationName,
                        status: 'skipped',
                        reasonCode: 'tool_unavailable',
                        durationMs,
                    },
                    integrationContext: {
                        kind: 'web_search',
                        version: 'v1',
                        payload: {
                            attempts,
                            searchHints,
                        } satisfies WebSearchContextStepIntegrationPayload,
                    },
                };
            }
            if (attempts.some((attempt) => attempt.status === 'failed')) {
                return buildFailedContextStepResult({
                    toolName: request.integrationName,
                    reasonCode: 'tool_execution_error',
                    durationMs,
                    integrationContext: {
                        kind: 'web_search',
                        version: 'v1',
                        payload: {
                            attempts,
                            searchHints,
                        } satisfies WebSearchContextStepIntegrationPayload,
                    },
                });
            }
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: 'tool_not_used',
                    durationMs,
                },
                integrationContext: {
                    kind: 'web_search',
                    version: 'v1',
                    payload: {
                        attempts,
                        searchHints,
                    } satisfies WebSearchContextStepIntegrationPayload,
                },
            };
        }

        return buildExecutedContextStepResult({
            toolName: request.integrationName,
            durationMs,
            contextMessages: formatContextMessages(input.query, discovered),
            sources: discovered.map(normalizeCitation),
            integrationContext: {
                kind: 'web_search',
                version: 'v1',
                payload: {
                    attempts,
                    searchHints,
                } satisfies WebSearchContextStepIntegrationPayload,
            },
        });
    };
};

export type {
    WebSearchContextStepIntegrationPayload,
    WebSearchHint,
    WebSearchProviderAttempt,
    WebSearchProviderName,
} from './webSearchTypes.js';
