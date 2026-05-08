/**
 * @description: Web search context-step executor that emits provider-neutral search guidance for generation.
 * @footnote-scope: core
 * @footnote-module: WebSearchContextStepExecutor
 * @footnote-risk: low - Failures only affect optional search guidance and keep generation fail-open.
 * @footnote-ethics: medium - Clear search guidance improves transparency around retrieval behavior.
 */
import type { GenerationSearchRequest } from '@footnote/agent-runtime';
import type {
    ContextStepExecutor,
    ContextStepResult,
} from '../../workflowEngine.js';
import { buildWebSearchInstruction } from '../../chatGenerationHints.js';
import type { RuntimeConfig } from '../../../config/types.js';
import { resolveWebSearchProviderSelectionPlan } from './webSearchProviderPolicy.js';

const toGenerationSearchRequest = (
    input: unknown
): GenerationSearchRequest | undefined => {
    if (input === null || typeof input !== 'object') {
        return undefined;
    }
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.query !== 'string') {
        return undefined;
    }
    const query = candidate.query.trim();
    if (query.length === 0) {
        return undefined;
    }

    return {
        query,
        contextSize:
            candidate.contextSize === 'low' ||
            candidate.contextSize === 'medium' ||
            candidate.contextSize === 'high'
                ? candidate.contextSize
                : 'medium',
        intent:
            candidate.intent === 'repo_explainer' ||
            candidate.intent === 'current_facts'
                ? candidate.intent
                : 'current_facts',
        ...(Array.isArray(candidate.repoHints) && {
            repoHints: candidate.repoHints.filter(
                (hint): hint is string =>
                    typeof hint === 'string' && hint.trim().length > 0
            ),
        }),
        ...(Array.isArray(candidate.topicHints) && {
            topicHints: candidate.topicHints.filter(
                (hint): hint is string =>
                    typeof hint === 'string' && hint.trim().length > 0
            ),
        }),
    };
};

export const createWebSearchContextStepExecutor =
    /**
     * Creates the web-search Context Step executor used by workflow orchestration.
     *
     * The executor validates request shape, resolves provider-selection policy,
     * and emits a provider-neutral search instruction as a system context message.
     *
     * @param input.providerPolicy - Optional provider policy from runtime config
     * (`RuntimeConfig['webSearchProviders']`). When omitted, defaults to an
     * `auto` policy with OpenAI enabled and ordered first.
     * @returns ContextStepExecutor
     *
     * Fail-open behavior:
     * - Returns `skipped/tool_not_requested` when the request is not requested.
     * - Returns `skipped/tool_unavailable` when the request is ineligible.
     * - Returns `failed/unspecified_tool_outcome` when input is malformed.
     * - Returns `skipped/tool_unavailable` when no providers are selectable.
     *
     * Authority/provenance:
     * - Execution policy authority is backend-owned via provider policy.
     * - Provider protocol execution remains outside this executor boundary.
     *
     * Side effects/logging:
     * - No network calls and no logging side effects.
     */
    (input?: {
        providerPolicy?: RuntimeConfig['webSearchProviders'];
    }): ContextStepExecutor =>
    async ({ request }): Promise<ContextStepResult> => {
        if (!request.requested) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: request.reasonCode ?? 'tool_not_requested',
                },
            };
        }
        if (!request.eligible) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: request.reasonCode ?? 'tool_unavailable',
                },
            };
        }

        const searchRequest = toGenerationSearchRequest(request.input);
        if (!searchRequest) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'failed',
                    reasonCode: 'unspecified_tool_outcome',
                },
            };
        }
        const selectionPlan = resolveWebSearchProviderSelectionPlan({
            policy: input?.providerPolicy ?? {
                mode: 'auto',
                enabledProviders: ['openai'],
                providerOrder: ['openai'],
            },
            // Current scaffolding: only OpenAI-backed search is executable today.
            // Brave/SearXNG will be added as dedicated providers in follow-up work.
            availableProviders: ['openai'],
        });
        if (selectionPlan.candidates.length === 0) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: 'tool_unavailable',
                },
            };
        }

        return {
            executionContext: {
                toolName: request.integrationName,
                status: 'executed',
            },
            contextMessages: [buildWebSearchInstruction(searchRequest)],
        };
    };
