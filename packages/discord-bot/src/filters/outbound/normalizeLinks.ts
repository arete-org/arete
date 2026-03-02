/**
 * @description: Normalizes outbound URLs into Markdown autolinks (<url>) without reflowing formatting.
 * @footnote-scope: interface
 * @footnote-module: NormalizeOutboundLinks
 * @footnote-risk: medium - Linkification errors can distort meaning or intent.
 * @footnote-ethics: medium - Formatting changes shape user interpretation and trust.
 */

// used only to run a Markdown parse so we can target edits by source offsets (no re-serialization/reflow).
import { unified } from 'unified';

// turns Markdown into an mdast AST with positional info, letting us identify “do not touch” spans (links/code/etc.).
import remarkParse from 'remark-parse';

// walks the AST so we can collect protected ranges and avoid editing inside Markdown constructs.
import { visit } from 'unist-util-visit';

// provides robust URL detection in plain text (punctuation/parentheses/etc.) without maintaining a regex.
import LinkifyIt from 'linkify-it';

// the AST type produced by remark-parse.
import type { Root } from 'mdast';

// the base type for nodes visited in the AST walker.
import type { Node } from 'unist';

// this filter’s return contract: { content, changes } for pipeline logging/telemetry.
import type { OutboundFilterResult } from './types.js';

// represents a portion of the scanned text.
interface TextRange {
    start: number;
    end: number;
}

// Linkify is scoped to this module to keep behavior consistent and testable.
const linkify = new LinkifyIt();

// Node types that should never be rewritten by the outbound normalizer.
// https://www.npmjs.com/package/mdast
const PROTECTED_NODE_TYPES = new Set<string>([
    'link',
    'linkReference',
    'definition',
    'inlineCode',
    'code',
    'html',
    'image',
    'imageReference',
]);

/**
 * Wraps bare URLs in "<...>" so Markdown renders them as links.
 * Note: Discord suppresses embeds for links formatted this way.
 *
 * What changes:
 * - For each URL we detect in normal text, we wrap it with "<" and ">" only.
 * - The only new characters we add are those angle brackets.
 *
 * What counts as a plain-text URL:
 * - It appears in normal text, and NOT inside existing Markdown links/images,
 *   code blocks, inline code, raw HTML, or reference definitions.
 * - We only run this filter when the message contains "http://" or "https://"
 * - Reflow is avoided so line breaks and original formatting stay intact.
 *
 * How:
 * - We parse first to find protected ranges (links, images, code, definitions, HTML),
 *   then scan only the remaining text outside those ranges.
 * - URL detection is handled by linkify-it so we don't maintain our own edge-case
 *   rules (punctuation, parentheses, trailing periods, etc.).
 */
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

    // Parse content to find protected regions we must not modify.
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

// Collect source ranges that should NOT be modified (see PROTECTED_NODE_TYPES)
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

