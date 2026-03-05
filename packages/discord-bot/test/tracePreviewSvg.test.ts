/**
 * @description: Validates deterministic TRACE preview SVG rendering for experimental Discord attachments.
 * @footnote-scope: test
 * @footnote-module: TracePreviewSvgTests
 * @footnote-risk: low - Test-only assertions around experimental rendering output.
 * @footnote-ethics: low - Uses synthetic metadata and no user-identifying data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseTemperament } from '@footnote/contracts/ethics-core';
import { renderTracePreviewSvg } from '../src/utils/tracePreview/tracePreviewSvg.js';

test('renderTracePreviewSvg renders the SVG shell and TRACE axis labels', () => {
    const svg = renderTracePreviewSvg({
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
    assert.match(svg, /TRACE PREVIEW/);
});

test('renderTracePreviewSvg clamps chip values and includes normalized axis summary', () => {
    // Cast is intentional for this fail-open test: runtime normalization should
    // still clamp bad numeric values even if typed callers use TraceAxisScore.
    const outOfRangeTemperament = {
        tightness: 99,
        rationale: -4,
        attribution: 6.6,
        caution: 1,
        extent: 10,
    } as unknown as ResponseTemperament;

    const svg = renderTracePreviewSvg({
        temperament: outOfRangeTemperament,
        chips: {
            confidencePercent: 181,
            riskTier: 'Medium',
            tradeoffCount: -3,
        },
    });

    assert.match(svg, /CONF 100%/);
    assert.match(svg, /RISK Medium/);
    assert.match(svg, /TRADEOFFS 0/);
    assert.match(svg, /T10 R1 A7 C1 E10/);
});
