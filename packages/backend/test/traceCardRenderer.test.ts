/**
 * @description: Verifies canonical trace-card SVG rendering and PNG conversion behavior.
 * @footnote-scope: test
 * @footnote-module: TraceCardRendererTests
 * @footnote-risk: low - Test-only checks for deterministic rendering and rasterization invariants.
 * @footnote-ethics: low - Uses synthetic TRACE values and no user-identifying data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseTemperament } from '@footnote/contracts/ethics-core';
import { renderTraceCardPng } from '../src/services/traceCard/traceCardRaster.js';
import { renderTraceCardSvg } from '../src/services/traceCard/traceCardSvg.js';

/**
 * Reads PNG dimensions directly from IHDR bytes.
 * PNG stores width/height as 32-bit big-endian integers at bytes 16..23.
 */
const readPngDimensions = (png: Buffer): { width: number; height: number } => {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    return { width, height };
};

test('renderTraceCardSvg includes wheel labels and fallback chip text', () => {
    const svg = renderTraceCardSvg({
        temperament: {
            tightness: 9,
            rationale: 6,
            attribution: 8,
            caution: 6,
            extent: 7,
        },
    });

    assert.match(svg, /<svg[^>]*>/);
    assert.match(svg, />T</);
    assert.match(svg, />R</);
    assert.match(svg, />A</);
    assert.match(svg, />C</);
    assert.match(svg, />E</);
    assert.match(svg, /TRACE CARD/);
});

test('renderTraceCardSvg normalizes out-of-range temperament values', () => {
    const outOfRangeTemperament = {
        tightness: 22,
        rationale: -3,
        attribution: 6.2,
        caution: Number.NaN,
        extent: Number.POSITIVE_INFINITY,
    } as unknown as ResponseTemperament;

    const svg = renderTraceCardSvg({
        temperament: outOfRangeTemperament,
    });

    assert.match(svg, /T10 R1 A6 C5 E5/);
});

test('renderTraceCardPng returns PNG bytes with expected signature and dimensions', () => {
    const requestedWidth = 448;
    const requestedHeight = 96;
    const { png } = renderTraceCardPng({
        temperament: {
            tightness: 8,
            rationale: 7,
            attribution: 9,
            caution: 6,
            extent: 8,
        },
        width: requestedWidth,
        height: requestedHeight,
    });

    assert.equal(png[0], 0x89);
    assert.equal(png[1], 0x50);
    assert.equal(png[2], 0x4e);
    assert.equal(png[3], 0x47);

    const dimensions = readPngDimensions(png);
    assert.equal(dimensions.width, requestedWidth);
    assert.equal(dimensions.height, requestedHeight);
});
