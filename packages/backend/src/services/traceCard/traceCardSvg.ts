/**
 * @description: Renders canonical TRACE card SVG assets for storage and cross-surface reuse.
 * @footnote-scope: core
 * @footnote-module: TraceCardSvgRenderer
 * @footnote-risk: medium - Rendering regressions can distort provenance visuals across Discord and web surfaces.
 * @footnote-ethics: medium - TRACE visuals shape user trust in how model behavior is communicated.
 */
import type { ResponseTemperament } from '@footnote/contracts/ethics-core';

type TraceAxisKey = keyof ResponseTemperament;
type NormalizedTemperament = Record<TraceAxisKey, number>;

type TraceAxisSpec = {
    key: TraceAxisKey;
    color: `#${string}`;
};

export type TraceCardChipData = {
    evidenceScore: number;
    freshnessScore: number;
};

/**
 * Inputs for trace-card SVG rendering.
 * Width and height are optional so callers can rely on stable defaults.
 */
export type TraceCardRenderInput = {
    temperament: ResponseTemperament;
    chips: TraceCardChipData;
    width?: number;
    height?: number;
};

type ScoreRow = {
    key: 'evidence' | 'freshness';
    icon: string;
    score: number;
    y: number;
};

const AXIS_SPECS: TraceAxisSpec[] = [
    { key: 'tightness', color: '#64748B' },
    { key: 'rationale', color: '#6366F1' },
    { key: 'attribution', color: '#14B8A6' },
    { key: 'caution', color: '#F59E0B' },
    { key: 'extent', color: '#84A98C' },
];

const DEFAULT_WIDTH = 172;
const DEFAULT_HEIGHT = 40;
const OUTER_RING_STROKE = '#D1D5DB';
const TEXT_COLOR = '#CBD5E1';
const TICK_NEUTRAL = '#D1D5DB';
const TICK_FILLED = '#8FA3BE';

// Wheel geometry must stay pinned exactly to preserve the existing visual baseline.
const WHEEL_LEFT = 1;
const WHEEL_TOP = 1;
const WHEEL_CENTER_X = 20;
const WHEEL_CENTER_Y = 20;
const WHEEL_OUTER_RADIUS = 19;
const WHEEL_INNER_RADIUS = 6;

// Right-side block placement and geometry.
const BLOCK_LEFT = WHEEL_LEFT + WHEEL_OUTER_RADIUS * 2 + 10;
const BLOCK_TOP = WHEEL_TOP + 6;
const ROW_HEIGHT = 12;
const ROW_GAP = 6;
const ICON_COLUMN_WIDTH = 12;
const BAR_OFFSET_FROM_LABEL = 5;
const TICK_WIDTH = 10;
const TICK_HEIGHT = 6;
const TICK_GAP = 2;
const TICK_RADIUS = 2;
const TICK_COUNT = 5;
const BAR_WIDTH = TICK_COUNT * TICK_WIDTH + (TICK_COUNT - 1) * TICK_GAP;
const BAR_START_X = BLOCK_LEFT + ICON_COLUMN_WIDTH + BAR_OFFSET_FROM_LABEL;
const REQUIRED_WIDTH = BAR_START_X + BAR_WIDTH + 1;

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

const normalizeScore = (value: number): number =>
    normalizeAxisValue(value, 1, 5, 3);

const buildScoreRows = (chips: TraceCardChipData): ScoreRow[] => [
    {
        key: 'evidence',
        icon: '🔗',
        score: normalizeScore(chips.evidenceScore),
        y: BLOCK_TOP,
    },
    {
        key: 'freshness',
        icon: '🕒',
        score: normalizeScore(chips.freshnessScore),
        y: BLOCK_TOP + ROW_HEIGHT + ROW_GAP,
    },
];

const renderScoreRow = (
    row: ScoreRow,
    defs: string[],
    layers: string[]
): void => {
    const textY = row.y + ROW_HEIGHT / 2;
    const tickY = row.y + (ROW_HEIGHT - TICK_HEIGHT) / 2;

    layers.push(
        `<text x="${BLOCK_LEFT}" y="${toSvgNumber(textY)}" text-anchor="start" dominant-baseline="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" font-weight="700" fill="${TEXT_COLOR}">${row.icon}</text>`
    );

    for (let index = 0; index < TICK_COUNT; index += 1) {
        const tickX = BAR_START_X + index * (TICK_WIDTH + TICK_GAP);
        const clipId = `tick-clip-${row.key}-${index + 1}`;
        const fillRatio = clamp(row.score - index, 0, 1);
        const filledWidth = fillRatio * TICK_WIDTH;

        layers.push(
            `<rect x="${toSvgNumber(tickX)}" y="${toSvgNumber(tickY)}" width="${TICK_WIDTH}" height="${TICK_HEIGHT}" rx="${TICK_RADIUS}" fill="${TICK_NEUTRAL}" fill-opacity="0.08" stroke="${TICK_NEUTRAL}" stroke-width="1" stroke-opacity="0.3" />`
        );
        if (filledWidth <= 0) {
            continue;
        }

        defs.push(
            `<clipPath id="${clipId}"><rect x="${toSvgNumber(tickX)}" y="${toSvgNumber(tickY)}" width="${TICK_WIDTH}" height="${TICK_HEIGHT}" rx="${TICK_RADIUS}" /></clipPath>`
        );
        layers.push(
            `<rect x="${toSvgNumber(tickX)}" y="${toSvgNumber(tickY)}" width="${toSvgNumber(filledWidth)}" height="${TICK_HEIGHT}" fill="${TICK_FILLED}" fill-opacity="0.62" clip-path="url(#${clipId})" />`
        );
    }
};

/**
 * Renders canonical trace-card SVG for storage and downstream conversion.
 */
export const renderTraceCardSvg = (input: TraceCardRenderInput): string => {
    const width = Math.max(
        REQUIRED_WIDTH,
        Math.round(input.width ?? DEFAULT_WIDTH)
    );
    const height = Math.max(
        DEFAULT_HEIGHT,
        Math.round(input.height ?? DEFAULT_HEIGHT)
    );
    const normalizedTemperament = normalizeTemperament(input.temperament);
    const bandCount = 4;
    const bandThickness = (WHEEL_OUTER_RADIUS - WHEEL_INNER_RADIUS) / bandCount;
    const bandGap = 0.8;
    const sliceAngle = (Math.PI * 2) / AXIS_SPECS.length;
    const baseStartAngle = (-3 * Math.PI) / 4;
    const sliceGapAngle = 1.2 / WHEEL_OUTER_RADIUS;
    const epsilon = 0.0001;
    const wheelLayers: string[] = [];
    const metadataLayers: string[] = [];
    const defs: string[] = [];

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
            const rawBandInner = WHEEL_INNER_RADIUS + bandIndex * bandThickness;
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
                `<path d="${ringSectorPath(WHEEL_CENTER_X, WHEEL_CENTER_Y, bandInner, filledOuter, startAngle, endAngle)}" fill="${axis.color}" />`
            );
        }
    }

    for (const row of buildScoreRows(input.chips)) {
        renderScoreRow(row, defs, metadataLayers);
    }

    const outerRing = `<circle cx="${toSvgNumber(WHEEL_CENTER_X)}" cy="${toSvgNumber(WHEEL_CENTER_Y)}" r="${toSvgNumber(WHEEL_OUTER_RADIUS)}" fill="none" stroke="${OUTER_RING_STROKE}" stroke-width="0.6" stroke-opacity="0.7" />`;
    const defsBlock = defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '';

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="TRACE card">`,
        '<title>TRACE card</title>',
        '<desc>TRACE wheel with fixed Evidence and Freshness metadata bars.</desc>',
        defsBlock,
        ...wheelLayers,
        outerRing,
        ...metadataLayers,
        '</svg>',
    ]
        .filter((line) => line.length > 0)
        .join('\n');
};
