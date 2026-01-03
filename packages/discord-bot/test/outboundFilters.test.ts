/**
 * @description: Ensures outbound link normalization behaves safely and predictably.
 * @arete-scope: test
 * @arete-module: OutboundFiltersTests
 * @arete-risk: low - Tests only validate formatting helpers.
 * @arete-ethics: moderate - Guards against accidental content distortion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOutboundLinks } from '../src/filters/outbound/normalizeLinks.js';

// Note: the normalizer wraps URLs as autolinks (<https://...>) for minimal formatting change.
test('normalizeOutboundLinks wraps bare URLs with markdown link text', () => {
    const input = 'Docs at https://example.com.';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        'Docs at <https://example.com>.'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});

// Confirm the cheap pre-check returns early when no URLs are present.
test('normalizeOutboundLinks returns early when no http(s) URLs are present', () => {
    const input = 'Plain text with no links here.';
    const result = normalizeOutboundLinks(input);

    // Fast path: when no URL is present, content should be untouched.
    assert.equal(result.content, input);
    assert.equal(result.changes.length, 0);
});

// Multiple URLs should each be wrapped and counted once.
test('normalizeOutboundLinks wraps multiple URLs and counts each change', () => {
    const input = 'One https://example.com and two https://example.org.';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        'One <https://example.com> and two <https://example.org>.'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:2']);
});

// Existing links should be preserved; only bare URLs should be linkified.
test('normalizeOutboundLinks preserves existing markdown links while linkifying bare URLs', () => {
    const input = 'See [Docs](https://example.com) and https://example.org.';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        'See [Docs](https://example.com) and <https://example.org>.'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});

test('normalizeOutboundLinks leaves existing markdown links untouched', () => {
    const input = 'Already [Example](https://example.com) in markdown.';
    const result = normalizeOutboundLinks(input);

    assert.equal(result.content, input);
    assert.equal(result.changes.length, 0);
});

// Autolinks are already safe; we should not rewrite or count them.
test('normalizeOutboundLinks leaves autolinks untouched', () => {
    const input = 'Autolink: <https://example.com>';
    const result = normalizeOutboundLinks(input);

    assert.equal(result.content, input);
    assert.equal(result.changes.length, 0);
});

// Formatting constructs should survive normalization (lists, quotes, emphasis).
test('normalizeOutboundLinks preserves list, quote, and emphasis formatting', () => {
    const input = [
        '- item with https://example.com',
        '> quote with https://example.org',
        '*emphasis with https://example.net*',
    ].join('\n');

    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        [
            '- item with <https://example.com>',
            '> quote with <https://example.org>',
            '*emphasis with <https://example.net>*',
        ].join('\n')
    );
    assert.deepEqual(result.changes, ['wrapped_urls:3']);
});

// URLs followed by punctuation should keep punctuation outside the link.
test('normalizeOutboundLinks handles punctuation around URLs', () => {
    const input = 'See https://example.com, https://example.org. End.';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        'See <https://example.com>, <https://example.org>. End.'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:2']);
});

// Query strings and parentheses are common in real links; ensure they stay intact.
test('normalizeOutboundLinks wraps URLs with query strings and parentheses', () => {
    const input = 'Lookup https://example.com?foo=bar(baz).';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        'Lookup <https://example.com?foo=bar(baz)>.' 
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});

// Inline code should never be modified by outbound normalization.
test('normalizeOutboundLinks skips inline code spans', () => {
    const input = 'Use `https://example.com` when testing.';
    const result = normalizeOutboundLinks(input);

    assert.equal(result.content, input);
    assert.equal(result.changes.length, 0);
});

// Fenced code blocks should be preserved verbatim, with normalization outside.
test('normalizeOutboundLinks skips code blocks but normalizes surrounding text', () => {
    const input = [
        '```js',
        'const url = "https://example.com";',
        '```',
        'More info https://example.com',
    ].join('\n');

    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        [
            '```js',
            'const url = "https://example.com";',
            '```',
            'More info <https://example.com>',
        ].join('\n')
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});
