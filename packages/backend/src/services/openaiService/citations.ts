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
                    const parsedUrl = new URL(annotation.url);
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
    let cursor = 0;

    while (cursor < text.length) {
        const labelStart = text.indexOf('[', cursor);
        if (labelStart === -1) {
            break;
        }
        const labelEnd = text.indexOf(']', labelStart + 1);
        if (labelEnd === -1) {
            break;
        }
        const urlStart = labelEnd + 1;
        if (text[urlStart] !== '(') {
            cursor = labelStart + 1;
            continue;
        }

        let parenthesisDepth = 0;
        let urlEnd = -1;
        for (let index = urlStart; index < text.length; index += 1) {
            const character = text[index];
            if (character === '(') {
                parenthesisDepth += 1;
                continue;
            }
            if (character === ')') {
                parenthesisDepth -= 1;
                if (parenthesisDepth === 0) {
                    urlEnd = index;
                    break;
                }
            }
        }
        if (urlEnd === -1) {
            cursor = labelStart + 1;
            continue;
        }

        const rawLabel = text.slice(labelStart + 1, labelEnd);
        const rawUrl = text.slice(urlStart + 1, urlEnd).trim();
        if (
            typeof rawLabel !== 'string' ||
            rawLabel.trim().length === 0 ||
            typeof rawUrl !== 'string'
        ) {
            cursor = urlEnd + 1;
            continue;
        }

        let normalizedUrl: string;
        try {
            const parsedUrl = new URL(rawUrl);
            if (
                parsedUrl.protocol !== 'http:' &&
                parsedUrl.protocol !== 'https:'
            ) {
                cursor = urlEnd + 1;
                continue;
            }
            normalizedUrl = parsedUrl.toString();
        } catch {
            cursor = urlEnd + 1;
            continue;
        }

        if (seenUrls.has(normalizedUrl)) {
            cursor = urlEnd + 1;
            continue;
        }

        seenUrls.add(normalizedUrl);
        citations.push({
            title: normalizeFallbackCitationTitle(rawLabel),
            url: normalizedUrl,
        });
        cursor = urlEnd + 1;
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
