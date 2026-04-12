/**
 * @description: Citation extraction utilities for backend OpenAI Responses API
 * output, including strict annotation parsing and narrow markdown fallback.
 * @footnote-scope: utility
 * @footnote-module: OpenAIServiceCitations
 * @footnote-risk: high - Citation parsing errors can drop retrieval evidence or emit malformed links.
 * @footnote-ethics: high - Provenance transparency depends on preserving user-visible source links.
 */

import type { Citation } from '@footnote/contracts/ethics-core';
import type { ResponsesApiOutputItem } from './types.js';

// Owns: citation extraction and fallback parsing from provider output text.
// Does not own: provenance classification policy or response metadata assembly.

/**
 * Extracts URL citations directly from OpenAI output annotations.
 * This is the hard-cutover path for provenance citations (no footer parsing).
 */
const extractCitationsFromOutputItems = (
    outputItems: ResponsesApiOutputItem[]
): Citation[] => {
    const citations: Citation[] = [];
    const seenCitations = new Set<string>();

    for (const item of outputItems) {
        if (
            item.type !== 'message' ||
            item.role !== 'assistant' ||
            !Array.isArray(item.content)
        ) {
            continue;
        }

        for (const contentItem of item.content) {
            if (
                contentItem.type !== 'output_text' ||
                !contentItem.text ||
                !Array.isArray(contentItem.annotations)
            ) {
                continue;
            }

            for (const annotation of contentItem.annotations) {
                if (
                    annotation.type !== 'url_citation' ||
                    typeof annotation.url !== 'string'
                ) {
                    continue;
                }

                let normalizedUrl: string;
                try {
                    normalizedUrl = new URL(annotation.url).toString();
                } catch {
                    continue;
                }

                const normalizedTitle =
                    typeof annotation.title === 'string' &&
                    annotation.title.trim().length > 0
                        ? annotation.title.trim()
                        : 'Source';
                const dedupeKey = `${normalizedUrl}::${normalizedTitle}`;
                if (seenCitations.has(dedupeKey)) {
                    continue;
                }

                seenCitations.add(dedupeKey);
                const snippet =
                    Number.isInteger(annotation.start_index) &&
                    Number.isInteger(annotation.end_index) &&
                    annotation.start_index >= 0 &&
                    annotation.end_index > annotation.start_index
                        ? contentItem.text.slice(
                              annotation.start_index,
                              annotation.end_index
                          )
                        : undefined;
                citations.push({
                    title: normalizedTitle,
                    url: normalizedUrl,
                    ...(snippet && snippet.trim().length > 0
                        ? { snippet }
                        : {}),
                });
            }
        }
    }

    return citations;
};

/**
 * Numeric markdown footnote markers are not useful user-facing titles.
 */
const normalizeFallbackCitationTitle = (label: string): string => {
    const normalizedLabel = label.trim();

    return /^\d+$/.test(normalizedLabel) ? 'Source' : normalizedLabel;
};

/**
 * Recovers visible markdown links when retrieved output lacks structured
 * `url_citation` annotations.
 *
 * This intentionally stays narrow: only markdown links are preserved here, and
 * only for retrieval-backed responses. Bare URLs are out of scope for this
 * fallback because they are more likely to capture incidental text.
 */
const extractMarkdownLinkCitations = (text: string): Citation[] => {
    const citations: Citation[] = [];
    const seenUrls = new Set<string>();
    const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

    for (const match of text.matchAll(markdownLinkPattern)) {
        const rawLabel = match[1];
        const rawUrl = match[2];
        if (
            typeof rawLabel !== 'string' ||
            rawLabel.trim().length === 0 ||
            typeof rawUrl !== 'string'
        ) {
            continue;
        }

        let normalizedUrl: string;
        try {
            const parsedUrl = new URL(rawUrl);
            if (
                parsedUrl.protocol !== 'http:' &&
                parsedUrl.protocol !== 'https:'
            ) {
                continue;
            }
            normalizedUrl = parsedUrl.toString();
        } catch {
            continue;
        }

        if (seenUrls.has(normalizedUrl)) {
            continue;
        }

        seenUrls.add(normalizedUrl);
        citations.push({
            title: normalizeFallbackCitationTitle(rawLabel),
            url: normalizedUrl,
        });
    }

    return citations;
};

/**
 * Detects whether the model output includes an executed web search tool call.
 * This is stronger evidence than planner intent alone.
 */
const hasWebSearchCallInOutputItems = (
    outputItems: ResponsesApiOutputItem[]
): boolean => outputItems.some((item) => item.type === 'web_search_call');

export {
    extractCitationsFromOutputItems,
    extractMarkdownLinkCitations,
    hasWebSearchCallInOutputItems,
    normalizeFallbackCitationTitle,
};
