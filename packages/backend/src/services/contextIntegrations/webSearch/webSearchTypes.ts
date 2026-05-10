/**
 * @description: Shared type contracts for web-search context integration execution.
 * @footnote-scope: interface
 * @footnote-module: WebSearchContextTypes
 * @footnote-risk: low - Type drift can cause compile-time breakage in provider and executor wiring.
 * @footnote-ethics: low - Type declarations shape metadata but do not alter policy authority.
 */
import type { ToolInvocationReasonCode } from '@footnote/contracts/policy';

export type WebSearchProviderName = 'searxng' | 'brave' | 'serpapi';

export type WebSearchInput = {
    query: string;
    intent?: 'repo_explainer' | 'current_facts';
    contextSize?: 'low' | 'medium' | 'high';
    repoHints?: string[];
    topicHints?: string[];
};

export type WebSearchRecord = {
    title: string;
    url: string;
    snippet?: string;
    provider: WebSearchProviderName;
};

export type WebSearchHint = {
    query: string;
    intent: 'repo_explainer' | 'current_facts';
    priority: 'low' | 'medium' | 'high';
    reason?: string;
};

export type WebSearchProviderAttempt = {
    provider: WebSearchProviderName;
    status: 'executed_with_results' | 'executed_empty' | 'skipped' | 'failed';
    reasonCode?: ToolInvocationReasonCode;
    durationMs: number;
    resultCount: number;
};

export type WebSearchContextStepIntegrationPayload = {
    attempts: WebSearchProviderAttempt[];
    searchHints: WebSearchHint[];
};

export type WebSearchProviderResult =
    | { ok: true; records: WebSearchRecord[] }
    | { ok: false; reasonCode: ToolInvocationReasonCode };
