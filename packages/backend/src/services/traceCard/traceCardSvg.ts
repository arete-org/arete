/**
 * @description: Renders canonical TRACE card SVG assets for storage and cross-surface reuse.
 * @footnote-scope: core
 * @footnote-module: TraceCardSvgRenderer
 * @footnote-risk: medium - Rendering regressions can distort provenance visuals across Discord and web surfaces.
 * @footnote-ethics: medium - TRACE visuals shape user trust in how model behavior is communicated.
 */
import type {
    ResponseTemperament,
    RiskTier,
} from '@footnote/contracts/ethics-core';

type TraceAxisKey = keyof ResponseTemperament;
type NormalizedTemperament = Record<TraceAxisKey, number>;

type TraceAxisSpec = {
    key: TraceAxisKey;
    color: `#${string}`;
};

/**
 * Optional metadata accepted for trace-card compatibility.
 * Currently unused by SVG rendering.
 */
export type TraceCardChipData = {
    confidencePercent?: number;
    riskTier?: RiskTier;
    tradeoffCount?: number;
};

/**
 * Inputs for trace-card SVG rendering.
 * Width and height are optional so callers can rely on stable defaults.
 */
export type TraceCardRenderInput = {
    temperament: ResponseTemperament;
    chips?: TraceCardChipData;
    width?: number;
    height?: number;
};

const AXIS_SPECS: TraceAxisSpec[] = [
    { key: 'tightness', color: '#64748B' },
    { key: 'rationale', color: '#6366F1' },
    { key: 'attribution', color: '#14B8A6' },
    { key: 'caution', color: '#F59E0B' },
    { key: 'extent', color: '#84A98C' },
];

const DEFAULT_WIDTH = 40;
const DEFAULT_HEIGHT = 40;
const OUTER_RING_STROKE = '#D1D5DB';

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

const normalizeAxisValue = (
    value: number,
    min: number,
    max: number,
    fallback: number
): number => {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return clamp(value, min, max);
};

const toSvgNumber = (value: number): string => {
    const fixed = value.toFixed(2);
    return fixed.replace(/\.00$/, '');
};

const polarPoint = (
    cx: number,
    cy: number,
    radius: number,
    angle: number
): { x: number; y: number } => ({
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
});

const ringSectorPath = (
    cx: number,
    cy: number,
    innerRadius: number,
    outerRadius: number,
    startAngle: number,
    endAngle: number
): string => {
    const outerStart = polarPoint(cx, cy, outerRadius, startAngle);
    const outerEnd = polarPoint(cx, cy, outerRadius, endAngle);
    const innerEnd = polarPoint(cx, cy, innerRadius, endAngle);
    const innerStart = polarPoint(cx, cy, innerRadius, startAngle);
    const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;

    return [
        `M ${toSvgNumber(outerStart.x)} ${toSvgNumber(outerStart.y)}`,
        `A ${toSvgNumber(outerRadius)} ${toSvgNumber(outerRadius)} 0 ${largeArcFlag} 1 ${toSvgNumber(outerEnd.x)} ${toSvgNumber(outerEnd.y)}`,
        `L ${toSvgNumber(innerEnd.x)} ${toSvgNumber(innerEnd.y)}`,
        `A ${toSvgNumber(innerRadius)} ${toSvgNumber(innerRadius)} 0 ${largeArcFlag} 0 ${toSvgNumber(innerStart.x)} ${toSvgNumber(innerStart.y)}`,
        'Z',
    ].join(' ');
};

/**
 * Normalizes axis values to continuous 1..10 and fails open to midpoint 5.
 */
const normalizeTemperament = (
    temperament: ResponseTemperament
): NormalizedTemperament => {
    const normalizeAxis = (value: number): number =>
        normalizeAxisValue(value, 1, 10, 5);

    return {
        tightness: normalizeAxis(temperament.tightness),
        rationale: normalizeAxis(temperament.rationale),
        attribution: normalizeAxis(temperament.attribution),
        caution: normalizeAxis(temperament.caution),
        extent: normalizeAxis(temperament.extent),
    };
};

/**
 * Renders canonical trace-card SVG for storage and downstream conversion.
 */
export const renderTraceCardSvg = (input: TraceCardRenderInput): string => {
    const width = Math.max(36, Math.round(input.width ?? DEFAULT_WIDTH));
    const height = Math.max(36, Math.round(input.height ?? DEFAULT_HEIGHT));
    const normalizedTemperament = normalizeTemperament(input.temperament);
    const wheelPadding = 1;
    const wheelCenterX = width / 2;
    const wheelCenterY = height / 2;
    const outerRadius = Math.min(width, height) / 2 - wheelPadding;
    const innerRadius = 6;
    const bandCount = 5;
    const bandThickness = (outerRadius - innerRadius) / bandCount;
    const bandGap = 0.8;
    const sliceAngle = (Math.PI * 2) / AXIS_SPECS.length;
    const baseStartAngle = (-3 * Math.PI) / 4;
    const sliceGapAngle = 1.2 / outerRadius;
    const epsilon = 0.0001;
    const wheelLayers: string[] = [];

    for (let index = 0; index < AXIS_SPECS.length; index += 1) {
        const axis = AXIS_SPECS[index];
        const startAngle =
            baseStartAngle + index * sliceAngle + sliceGapAngle / 2;
        const endAngle =
            baseStartAngle + (index + 1) * sliceAngle - sliceGapAngle / 2;
        if (endAngle <= startAngle + epsilon) {
            continue;
        }

        const score = normalizedTemperament[axis.key];
        const scoreProgress = score / 10;

        for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
            const bandStart = bandIndex / bandCount;
            const bandEnd = (bandIndex + 1) / bandCount;
            const rawBandInner = innerRadius + bandIndex * bandThickness;
            const rawBandOuter = rawBandInner + bandThickness;
            const bandInner = rawBandInner + bandGap / 2;
            const bandOuter = rawBandOuter - bandGap / 2;
            if (bandOuter <= bandInner + epsilon) {
                continue;
            }

            if (scoreProgress <= bandStart + epsilon) {
                continue;
            }

            const bandFillFraction = clamp(
                (scoreProgress - bandStart) / (bandEnd - bandStart),
                0,
                1
            );
            const filledOuter =
                bandInner + (bandOuter - bandInner) * bandFillFraction;
            if (filledOuter <= bandInner + epsilon) {
                continue;
            }

            wheelLayers.push(
                `<path d="${ringSectorPath(wheelCenterX, wheelCenterY, bandInner, filledOuter, startAngle, endAngle)}" fill="${axis.color}" />`
            );
        }
    }

    const outerRing = `<circle cx="${toSvgNumber(wheelCenterX)}" cy="${toSvgNumber(wheelCenterY)}" r="${toSvgNumber(outerRadius)}" fill="none" stroke="${OUTER_RING_STROKE}" stroke-width="0.6" stroke-opacity="0.7" />`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="TRACE card">`,
        '<title>TRACE card</title>',
        '<desc>TRACE wheel with transparent background.</desc>',
        ...wheelLayers,
        outerRing,
        '</svg>',
    ].join('\n');
};
