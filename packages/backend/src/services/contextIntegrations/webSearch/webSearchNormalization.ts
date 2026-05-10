/**
 * @description: Input and citation normalization helpers for web-search context integration.
 * @footnote-scope: utility
 * @footnote-module: WebSearchNormalization
 * @footnote-risk: medium - Normalization bugs can drop or mis-shape search records.
 * @footnote-ethics: medium - Incorrect normalization can reduce transparency of source attribution.
 */
import type { Citation } from '@footnote/contracts/policy';
import type { WebSearchInput, WebSearchRecord } from './webSearchTypes.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseWebSearchInput = (
    input: unknown
): WebSearchInput | undefined => {
    if (!isRecord(input) || typeof input.query !== 'string') {
        return undefined;
    }
    const query = input.query.trim();
    if (query.length === 0) {
        return undefined;
    }
    return {
        query,
        intent:
            input.intent === 'repo_explainer' ||
            input.intent === 'current_facts'
                ? input.intent
                : 'current_facts',
        contextSize:
            input.contextSize === 'low' ||
            input.contextSize === 'medium' ||
            input.contextSize === 'high'
                ? input.contextSize
                : 'medium',
        repoHints: Array.isArray(input.repoHints)
            ? input.repoHints.filter((v): v is string => typeof v === 'string')
            : undefined,
        topicHints: Array.isArray(input.topicHints)
            ? input.topicHints.filter((v): v is string => typeof v === 'string')
            : undefined,
    };
};

export const normalizeUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
};

export const normalizeCitation = (record: WebSearchRecord): Citation => ({
    title: record.title.trim().length > 0 ? record.title.trim() : 'Source',
    url: record.url,
    ...(record.snippet && record.snippet.trim().length > 0
        ? { snippet: record.snippet.trim() }
        : {}),
});
