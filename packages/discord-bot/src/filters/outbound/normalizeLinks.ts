/**
 * @description: Normalizes outbound URLs into Markdown links without reflowing formatting.
 * @arete-scope: interface
 * @arete-module: NormalizeOutboundLinks
 * @arete-risk: moderate - Linkification errors can distort meaning or intent.
 * @arete-ethics: moderate - Formatting changes shape user interpretation and trust.
 */

// Unified is the pipeline runner that parses Markdown into an AST.
// AST: Abstract Syntax Tree; a tree representation of the Markdown document.
import { unified } from 'unified';
// remark-parse turns Markdown text into a typed AST so we can avoid regex hacks.
import remarkParse from 'remark-parse';
// unist-util-visit walks the AST so we can gather protected ranges safely.
import { visit } from 'unist-util-visit';
// linkify-it detects URLs inside plain text segments.
import LinkifyIt from 'linkify-it';
import type { Root } from 'mdast';
import type { Node } from 'unist';

import type { OutboundFilterResult } from './types.js';

interface TextRange {
    start: number;
    end: number;
}

// Linkify is scoped to this module to keep behavior consistent and testable.
const linkify = new LinkifyIt();

// Extract the match type without depending on LinkifyIt namespace types.
type LinkifyMatch = NonNullable<ReturnType<typeof linkify.match>>[number];

// Node types that should never be rewritten by the outbound normalizer.
const PROTECTED_NODE_TYPES = new Set<string>([
    'link',
    'linkReference',
    'definition',
    'inlineCode',
    'code',
    'image',
    'imageReference',
]);

// Normalize outbound links by wrapping bare URLs with markdown autolinks.
// We parse to find protected spans, then only rewrite raw text outside them.
export const normalizeOutboundLinks = (
    content: string
): OutboundFilterResult => {
    if (!content) {
        return { content, changes: [] };
    }

    // Fast path: skip parsing when there are no http(s) URLs to normalize.
    if (!content.includes('http://') && !content.includes('https://')) {
        return { content, changes: [] };
    }

    // Parse Markdown so we can safely ignore code blocks and existing links.
    const tree = unified().use(remarkParse).parse(content) as Root;
    const protectedRanges = collectProtectedRanges(tree, content.length);

    const { text: normalized, count } = linkifyWithProtectedRanges(
        content,
        protectedRanges
    );

    // Emit a compact summary for logging rather than per-link detail.
    const changes = count > 0 ? [`wrapped_urls:${count}`] : [];
    return { content: normalized, changes };
};

// Collect source ranges that should not be modified (links, code, images).
const collectProtectedRanges = (tree: Root, maxLength: number): TextRange[] => {
    const ranges: TextRange[] = [];

    visit(tree, (node: Node) => {
        if (!PROTECTED_NODE_TYPES.has(node.type)) {
            return;
        }

        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (typeof start !== 'number' || typeof end !== 'number') {
            return;
        }

        const clampedStart = Math.max(0, Math.min(start, maxLength));
        const clampedEnd = Math.max(0, Math.min(end, maxLength));
        if (clampedEnd <= clampedStart) {
            return;
        }

        ranges.push({ start: clampedStart, end: clampedEnd });
    });

    return mergeRanges(ranges);
};

// Merge overlapping ranges so we can scan the content efficiently.
const mergeRanges = (ranges: TextRange[]): TextRange[] => {
    if (ranges.length === 0) {
        return [];
    }

    const sorted = [...ranges].sort((first, second) => {
        if (first.start !== second.start) {
            return first.start - second.start;
        }
        return first.end - second.end;
    });

    const merged: TextRange[] = [{ ...sorted[0] }];

    for (const range of sorted.slice(1)) {
        const last = merged[merged.length - 1];
        if (range.start <= last.end) {
            last.end = Math.max(last.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }

    return merged;
};

// Apply linkification to content slices that are not protected.
const linkifyWithProtectedRanges = (
    content: string,
    ranges: TextRange[]
): { text: string; count: number } => {
    if (ranges.length === 0) {
        return linkifySegment(content);
    }

    let cursor = 0;
    let output = '';
    let total = 0;

    for (const range of ranges) {
        if (range.start > cursor) {
            const segment = content.slice(cursor, range.start);
            const { text, count } = linkifySegment(segment);
            output += text;
            total += count;
        }

        output += content.slice(range.start, range.end);
        cursor = range.end;
    }

    if (cursor < content.length) {
        const { text, count } = linkifySegment(content.slice(cursor));
        output += text;
        total += count;
    }

    return { text: output, count: total };
};

// Convert a single plain-text segment by wrapping detected URLs in autolinks.
const linkifySegment = (segment: string): { text: string; count: number } => {
    const matches = linkify.match(segment);
    if (!matches || matches.length === 0) {
        return { text: segment, count: 0 };
    }

    let result = '';
    let cursor = 0;
    let count = 0;

    for (const match of matches) {
        const start = match.index ?? 0;
        const end = match.lastIndex ?? start;

        if (start > cursor) {
            result += segment.slice(cursor, start);
        }

        const raw = match.raw ?? match.text ?? segment.slice(start, end);
        const url = raw || match.url;
        result += `<${url}>`;
        count += 1;
        cursor = end;
    }

    result += segment.slice(cursor);
    return { text: result, count };
};
