/**
 * @description: Normalizes outbound URLs into Markdown links using a Markdown AST.
 * @arete-scope: interface
 * @arete-module: NormalizeOutboundLinks
 * @arete-risk: moderate - Linkification errors can distort meaning or intent.
 * @arete-ethics: moderate - Formatting changes shape user interpretation and trust.
 */

// Unified is the pipeline runner that parses Markdown into an AST and serializes it back.
// AST: Abstract Syntax Tree; a tree representation of the Markdown document.
import { unified } from 'unified';
// remark-parse turns Markdown text into a typed AST so we can avoid regex hacks.
import remarkParse from 'remark-parse';
// remark-stringify converts the AST back into Markdown text after transforms.
import remarkStringify from 'remark-stringify';
// unist-util-visit walks the AST so we can rewrite only "text" nodes safely.
import { visit } from 'unist-util-visit';
// linkify-it detects URLs inside plain text nodes.
import LinkifyIt from 'linkify-it';
import type { Root, Text, PhrasingContent } from 'mdast';
import type { Parent } from 'unist';

import type { OutboundFilterResult } from './types.js';

// Linkify is scoped to this module to keep behavior consistent and testable.
const linkify = new LinkifyIt();

// Extract the match type without depending on LinkifyIt namespace types.
type LinkifyMatch = NonNullable<ReturnType<typeof linkify.match>>[number];

// Normalize outbound links by wrapping bare URLs with markdown links.
// We use an AST pipeline to safely rewrite text nodes without affecting code
// blocks or existing links.
export const normalizeOutboundLinks = (
    content: string
): OutboundFilterResult => {
    if (!content) {
        return { content, changes: [] };
    }

    // Fast path: skip AST work when there are no http(s) URLs to normalize.
    if (!content.includes('http://') && !content.includes('https://')) {
        return { content, changes: [] };
    }

    // Parse Markdown so we can safely ignore code blocks and existing links.
    // Parse with the core Markdown parser only. We intentionally skip remark-gfm
    // so bare URLs stay as text nodes for explicit linkification and counting.
    const tree = unified().use(remarkParse).parse(content) as Root;
    let linkifiedCount = 0;

    // Walk all text nodes and only rewrite when the parent is safe to edit.
    visit(
        tree,
        'text',
        (node: Text, index: number | undefined, parent: Parent | undefined) => {
            if (index === undefined || !parent || isProtectedParent(parent)) {
                return;
            }

            // Is this particular text node a URL?
            const matches = linkify.match(node.value);
            if (!matches || matches.length === 0) {
                return;
            }

            // If it is, expand it into a sequence of text + link nodes.
            const { children, linkifiedCount: nodeCount } = linkifyTextNode(
                node,
                matches
            );
            linkifiedCount += nodeCount;

            // Replace the original text node with the expanded sequence.
            parent.children.splice(index, 1, ...children);
            return index + children.length;
        }
    );

    // Convert the AST back into Markdown after transformations.
    const output = unified().use(remarkStringify).stringify(tree).trimEnd();

    // Emit a compact summary for logging rather than per-link detail.
    const changes =
        linkifiedCount > 0 ? [`wrapped_urls:${linkifiedCount}`] : [];
    return { content: output, changes };
};

// Skip transformations in nodes that already represent links or code.
// This ensures we do not double-link or alter code blocks/inline code.
const isProtectedParent = (parent?: Parent | null): boolean => {
    if (!parent) {
        return false;
    }

    return (
        parent.type === 'link' ||
        parent.type === 'linkReference' ||
        parent.type === 'definition' ||
        parent.type === 'inlineCode' ||
        parent.type === 'code'
    );
};

// Convert a text node into a sequence of text + link nodes based on linkify matches.
// This keeps the AST structure explicit instead of rewriting raw strings.
const linkifyTextNode = (
    node: Text,
    matches: LinkifyMatch[]
): { children: PhrasingContent[]; linkifiedCount: number } => {
    const children: PhrasingContent[] = [];
    let cursor = 0;
    let linkifiedCount = 0;

    // Build a new list of phrasing nodes, preserving non-link text slices.
    for (const match of matches) {
        const start = match.index ?? 0;
        const end = match.lastIndex ?? start;

        if (start > cursor) {
            children.push({
                type: 'text',
                value: node.value.slice(cursor, start),
            });
        }

        // Use linkify's display text when provided; fall back to the URL.
        const displayText = match.text ?? match.url;
        children.push({
            type: 'link',
            url: match.url,
            title: null,
            children: [{ type: 'text', value: displayText }],
        });
        linkifiedCount += 1;
        cursor = end;
    }

    if (cursor < node.value.length) {
        children.push({ type: 'text', value: node.value.slice(cursor) });
    }

    return { children, linkifiedCount };
};
