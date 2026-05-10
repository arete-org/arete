/**
 * @description: Prompt-facing formatting helpers for web-search context integration.
 * @footnote-scope: utility
 * @footnote-module: WebSearchPromptFormatting
 * @footnote-risk: medium - Formatting regressions can degrade model grounding clarity.
 * @footnote-ethics: medium - Incorrect labeling could overstate trust in unverified search snippets.
 */
import type {
    WebSearchHint,
    WebSearchInput,
    WebSearchRecord,
} from './webSearchTypes.js';

export const formatContextMessages = (
    query: string,
    records: WebSearchRecord[]
): string[] => {
    if (records.length === 0) {
        return [];
    }
    const sanitizeUntrustedText = (value: string): string =>
        Array.from(value)
            .map((char) => {
                const code = char.charCodeAt(0);
                return code < 32 || code === 127 ? ' ' : char;
            })
            .join('')
            .replace(/\s+/g, ' ')
            .trim();
    const lines = records.map((record, index) => {
        const title = sanitizeUntrustedText(record.title);
        const snippet =
            typeof record.snippet === 'string'
                ? sanitizeUntrustedText(record.snippet)
                : undefined;
        return snippet && snippet.length > 0
            ? `${index + 1}. UNTRUSTED SEARCH RESULT: ${title} (${record.url}) - ${snippet}`
            : `${index + 1}. UNTRUSTED SEARCH RESULT: ${title} (${record.url})`;
    });
    return [`Web search results for "${query}":`, ...lines];
};

export const buildSearchHints = (input: WebSearchInput): WebSearchHint[] => {
    const hints: WebSearchHint[] = [];
    const topicHints = input.topicHints ?? [];
    for (const topic of topicHints) {
        const trimmed = topic.trim();
        if (trimmed.length === 0) {
            continue;
        }
        hints.push({
            query: `${input.query} ${trimmed}`.trim(),
            intent: input.intent ?? 'current_facts',
            priority: 'medium',
            reason: 'topic_hint_refinement',
        });
    }
    if (input.intent === 'repo_explainer') {
        hints.push({
            query: `${input.query} ${[...(input.repoHints ?? [])].join(' ')}`.trim(),
            intent: 'repo_explainer',
            priority: 'high',
            reason: 'repo_explainer_deepening',
        });
    }
    return hints.slice(0, 3);
};
