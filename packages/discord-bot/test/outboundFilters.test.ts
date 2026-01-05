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

// Autolinks are already safe; only bare URLs should be wrapped and counted.
test('normalizeOutboundLinks leaves existing autolinks untouched while wrapping bare URLs', () => {
    const input = 'Already <https://example.com> and https://example.org';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        'Already <https://example.com> and <https://example.org>'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
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
test('normalizeOutboundLinks handles trailing punctuation and parentheses', () => {
    const cases = [
        {
            input: 'Trailing punctuation: https://example.com.',
            expected: 'Trailing punctuation: <https://example.com>.',
            count: 1,
        },
        {
            input: 'Parentheses: (https://example.com)',
            expected: 'Parentheses: (<https://example.com>)',
            count: 1,
        },
        {
            input: 'Commas/colons: https://example.com, next: https://example.org:',
            expected: 'Commas/colons: <https://example.com>, next: <https://example.org>:',
            count: 2,
        },
    ];

    for (const testCase of cases) {
        const result = normalizeOutboundLinks(testCase.input);
        assert.equal(result.content, testCase.expected);
        assert.deepEqual(result.changes, [`wrapped_urls:${testCase.count}`]);
    }
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
    const input = 'Use `https://example.com` and https://example.org';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        'Use `https://example.com` and <https://example.org>'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});

// Fenced code blocks should be preserved verbatim, with normalization outside.
test('normalizeOutboundLinks skips code blocks but normalizes surrounding text', () => {
    const input = [
        '```txt',
        'https://example.com should stay as-is here',
        '```',
        'More info https://example.org',
    ].join('\n');

    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        [
            '```txt',
            'https://example.com should stay as-is here',
            '```',
            'More info <https://example.org>',
        ].join('\n')
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});

// Reference-style links and definitions should remain untouched.
test('normalizeOutboundLinks skips reference-style links and definitions', () => {
    const input = [
        'See [Docs][ref] and https://example.org.',
        '',
        '[ref]: https://example.com',
    ].join('\n');
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        [
            'See [Docs][ref] and <https://example.org>.',
            '',
            '[ref]: https://example.com',
        ].join('\n')
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});

// Image URLs should remain untouched; only plain-text URLs are wrapped.
test('normalizeOutboundLinks skips image URLs', () => {
    const input = '![](https://example.com/img.png) and https://example.org';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        '![](https://example.com/img.png) and <https://example.org>'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});

// Raw HTML should remain untouched; only plain-text URLs are wrapped.
test('normalizeOutboundLinks skips raw HTML blocks', () => {
    const input = '<a href="https://example.com">x</a> https://example.org';
    const result = normalizeOutboundLinks(input);

    assert.equal(
        result.content,
        '<a href="https://example.com">x</a> <https://example.org>'
    );
    assert.deepEqual(result.changes, ['wrapped_urls:1']);
});
