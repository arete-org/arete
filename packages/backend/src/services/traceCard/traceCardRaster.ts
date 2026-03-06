/**
 * @description: Converts canonical trace-card SVG into PNG bytes for Discord-compatible delivery.
 * @footnote-scope: utility
 * @footnote-module: TraceCardRasterizer
 * @footnote-risk: medium - Conversion failures can block image delivery for preview command responses.
 * @footnote-ethics: low - Rasterization changes image format only; provenance semantics stay in canonical SVG.
 */
import { Resvg } from '@resvg/resvg-js';
import { renderTraceCardSvg, type TraceCardRenderInput } from './traceCardSvg.js';

/**
 * Renders a trace-card PNG from the canonical SVG source.
 * Returns both forms so callers can persist SVG and respond with PNG.
 */
export const renderTraceCardPng = (
    input: TraceCardRenderInput
): { svg: string; png: Buffer } => {
    const svg = renderTraceCardSvg(input);
    const resvg = new Resvg(svg);
    const png = Buffer.from(resvg.render().asPng());

    return { svg, png };
};

