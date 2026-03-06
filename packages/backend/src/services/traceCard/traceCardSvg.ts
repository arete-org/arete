/**
 * @description: Renders canonical TRACE card SVG assets for storage and cross-surface reuse.
 * @footnote-scope: core
 * @footnote-module: TraceCardSvgRenderer
 * @footnote-risk: medium - Rendering regressions can distort provenance visuals across Discord and web surfaces.
 * @footnote-ethics: medium - TRACE visuals shape user trust in how model behavior is communicated.
 */
import type {
    PartialResponseTemperament,
    ResponseTemperament,
    TraceAxisScore,
} from '@footnote/contracts/ethics-core';
import type { TraceCardChipData } from '@footnote/contracts/web';

type TraceAxisKey = keyof ResponseTemperament;
type NormalizedTemperament = Partial<Record<TraceAxisKey, TraceAxisScore>>;

type TraceAxisSpec = {
    key: TraceAxisKey;
    color: `#${string}`;
};

/**
 * Inputs for trace-card SVG rendering.
 * Width and height are optional so callers can rely on stable defaults.
 */
export type TraceCardRenderInput = {
    temperament?: PartialResponseTemperament;
    chips?: Partial<TraceCardChipData>;
    width?: number;
    height?: number;
};

type ScoreRow = {
    key: 'evidence' | 'freshness';
    score?: TraceAxisScore;
    y: number;
};

const AXIS_SPECS: TraceAxisSpec[] = [
    { key: 'tightness', color: '#008080' },
    { key: 'rationale', color: '#9A6373' },
    { key: 'attribution', color: '#E6AC00' },
    { key: 'caution', color: '#B87333' },
    { key: 'extent', color: '#5E7C5B' },
];

const DEFAULT_WIDTH = 172;
const DEFAULT_HEIGHT = 40;
const OUTER_RING_STROKE = '#D1D5DB';
const TEXT_COLOR = '#CBD5E1';
const TICK_NEUTRAL = '#D1D5DB';
const TICK_FILLED = '#8FA3BE';
const MISSING_FILL = '#EF4444';

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
const SCORE_ICON_SIZE = 10;
const SCORE_ICON_COLOR = TEXT_COLOR;
const ENLARGED_ICON_TRANSFORM_MATRIX = 'matrix(1.5 0 0 1.5';
const FINGERPRINT_ICON_TRANSFORM = `${ENLARGED_ICON_TRANSFORM_MATRIX} -48 -48)`;
const CLOCK_ICON_TRANSFORM = `${ENLARGED_ICON_TRANSFORM_MATRIX} -6 -6)`;
const FINGERPRINT_ICON_PATH =
    'M140.424 38.019a3.6 3.6 0 0 1-1.777-.462C123.81 29.934 110.983 26.7 95.528 26.7c-15.223 0-29.75 3.619-42.964 10.857-1.854 1.001-4.172.308-5.254-1.54-1.005-1.848-.31-4.235 1.545-5.236C63.228 22.85 78.992 19 95.528 19c16.537 0 30.91 3.619 46.673 11.55 1.932 1.155 2.628 3.465 1.623 5.313-.695 1.386-1.932 2.156-3.4 2.156ZM29.846 78.444a4.036 4.036 0 0 1-2.24-.693c-1.624-1.232-2.165-3.619-.928-5.39 7.65-10.78 17.386-19.25 28.977-25.179 24.419-12.474 55.328-12.551 79.669-.077 11.591 5.929 21.327 14.245 28.977 25.025 1.237 1.694.773 4.158-.927 5.39-1.777 1.232-4.173.847-5.409-.77-6.955-9.856-15.764-17.479-26.196-22.792-22.177-11.319-50.536-11.319-72.636.077-10.51 5.39-19.319 13.09-26.273 22.715-.618 1.155-1.778 1.694-3.014 1.694Zm48.296 92.939c-1.005 0-1.932-.385-2.705-1.155-6.722-6.699-10.354-11.011-15.532-20.328-5.332-9.471-8.113-21.021-8.113-33.418 0-22.869 19.627-41.503 43.736-41.503 24.11 0 43.737 18.634 43.737 41.503 0 1.021-.407 2-1.132 2.722a3.87 3.87 0 0 1-5.464 0 3.844 3.844 0 0 1-1.131-2.722c0-18.634-16.15-33.803-36.01-33.803-19.859 0-36.01 15.169-36.01 33.803 0 11.088 2.474 21.329 7.187 29.568 4.946 8.932 8.346 12.705 14.296 18.711a3.943 3.943 0 0 1 0 5.467c-.927.77-1.855 1.155-2.86 1.155Zm55.405-14.245c-9.196 0-17.309-2.31-23.955-6.853-11.514-7.777-18.391-20.405-18.391-33.803 0-1.021.407-2 1.132-2.722a3.871 3.871 0 0 1 5.464 0 3.843 3.843 0 0 1 1.131 2.722c0 10.857 5.564 21.098 14.991 27.412 5.487 3.696 11.9 5.467 19.628 5.467 1.854 0 4.945-.231 8.036-.77 2.087-.385 4.173 1.001 4.482 3.157.386 2.002-1.005 4.081-3.168 4.466-4.405.847-8.268.924-9.35.924ZM118.015 173h-1.005c-12.286-3.542-20.323-8.085-28.745-16.324-10.819-10.626-16.769-24.948-16.769-40.194 0-12.474 10.664-22.638 23.8-22.638 13.137 0 23.801 10.164 23.801 22.638 0 8.239 7.341 14.938 16.072 14.938 8.887 0 16.073-6.699 16.073-14.938 0-29.029-25.114-52.591-56.023-52.591-21.945 0-42.191 12.166-51.077 31.031-3.014 6.237-4.56 13.552-4.56 21.56 0 6.006.541 15.477 5.178 27.797.773 2.002-.232 4.235-2.241 4.928-2.01.693-4.25-.308-4.946-2.233-3.863-10.087-5.64-20.174-5.64-30.492 0-9.24 1.777-17.633 5.254-24.948 10.277-21.483 33.073-35.42 58.032-35.42 35.082 0 63.751 27.027 63.751 60.291 0 12.474-10.664 22.638-23.801 22.638-13.136 0-23.8-10.164-23.8-22.638 0-8.239-7.186-14.938-16.073-14.938-8.886 0-16.072 6.699-16.072 14.938 0 13.167 5.1 25.487 14.45 34.727 7.341 7.238 14.373 11.242 25.268 14.168 2.086.616 3.246 2.772 2.705 4.774-.387 1.771-2.009 2.926-3.632 2.926Z';
const CLOCK_ICON_PATH =
    'M12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4ZM2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12ZM11.8284 6.75736C12.3807 6.75736 12.8284 7.20507 12.8284 7.75736V12.7245L16.3553 14.0653C16.8716 14.2615 17.131 14.8391 16.9347 15.3553C16.7385 15.8716 16.1609 16.131 15.6447 15.9347L11.4731 14.349C11.085 14.2014 10.8284 13.8294 10.8284 13.4142V7.75736C10.8284 7.20507 11.2761 6.75736 11.8284 6.75736Z';

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));
const isTraceAxisScore = (value: unknown): value is TraceAxisScore =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5;

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
 * Builds a full sector from center to edge for missing TRACE values.
 */
const sectorPath = (
    cx: number,
    cy: number,
    outerRadius: number,
    startAngle: number,
    endAngle: number
): string => {
    const outerStart = polarPoint(cx, cy, outerRadius, startAngle);
    const outerEnd = polarPoint(cx, cy, outerRadius, endAngle);
    const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;

    return [
        `M ${toSvgNumber(cx)} ${toSvgNumber(cy)}`,
        `L ${toSvgNumber(outerStart.x)} ${toSvgNumber(outerStart.y)}`,
        `A ${toSvgNumber(outerRadius)} ${toSvgNumber(outerRadius)} 0 ${largeArcFlag} 1 ${toSvgNumber(outerEnd.x)} ${toSvgNumber(outerEnd.y)}`,
        'Z',
    ].join(' ');
};

/**
 * Normalizes axis values to integer 1..5 and omits invalid/missing axes.
 */
const normalizeTemperament = (
    temperament: PartialResponseTemperament | undefined
): NormalizedTemperament => {
    if (!temperament) {
        return {};
    }

    const normalized: NormalizedTemperament = {};
    for (const axis of AXIS_SPECS) {
        const score = temperament[axis.key];
        if (isTraceAxisScore(score)) {
            normalized[axis.key] = score;
        }
    }
    return normalized;
};

const normalizeScore = (
    value: number | undefined
): TraceAxisScore | undefined => (isTraceAxisScore(value) ? value : undefined);

const buildScoreRows = (
    chips: Partial<TraceCardChipData> | undefined
): ScoreRow[] => [
    {
        key: 'evidence',
        score: normalizeScore(chips?.evidenceScore),
        y: BLOCK_TOP,
    },
    {
        key: 'freshness',
        score: normalizeScore(chips?.freshnessScore),
        y: BLOCK_TOP + ROW_HEIGHT + ROW_GAP,
    },
];

const renderScoreIcon = (row: ScoreRow): string => {
    const iconX = BLOCK_LEFT + (ICON_COLUMN_WIDTH - SCORE_ICON_SIZE) / 2;
    const iconY = row.y + (ROW_HEIGHT - SCORE_ICON_SIZE) / 2;

    if (row.key === 'evidence') {
        return `<svg id="trace-icon-evidence" x="${toSvgNumber(iconX)}" y="${toSvgNumber(iconY)}" width="${SCORE_ICON_SIZE}" height="${SCORE_ICON_SIZE}" viewBox="0 0 192 192" aria-hidden="true" focusable="false"><path d="${FINGERPRINT_ICON_PATH}" transform="${FINGERPRINT_ICON_TRANSFORM}" fill="${SCORE_ICON_COLOR}" stroke="${SCORE_ICON_COLOR}" stroke-width="4" vector-effect="non-scaling-stroke"/></svg>`;
    }

    return `<svg id="trace-icon-freshness" x="${toSvgNumber(iconX)}" y="${toSvgNumber(iconY)}" width="${SCORE_ICON_SIZE}" height="${SCORE_ICON_SIZE}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="evenodd" clip-rule="evenodd" d="${CLOCK_ICON_PATH}" transform="${CLOCK_ICON_TRANSFORM}" fill="${SCORE_ICON_COLOR}" stroke="${SCORE_ICON_COLOR}" stroke-width="0.5" vector-effect="non-scaling-stroke" /></svg>`;
};

const renderScoreRow = (row: ScoreRow, layers: string[]): void => {
    const tickY = row.y + (ROW_HEIGHT - TICK_HEIGHT) / 2;

    layers.push(renderScoreIcon(row));

    for (let index = 0; index < TICK_COUNT; index += 1) {
        const tickX = BAR_START_X + index * (TICK_WIDTH + TICK_GAP);
        const score = row.score;
        const hasScore = score !== undefined;
        const shouldFill = score !== undefined && index < score;
        const neutralStroke = TICK_NEUTRAL;
        const neutralFill = TICK_NEUTRAL;

        layers.push(
            `<rect x="${toSvgNumber(tickX)}" y="${toSvgNumber(tickY)}" width="${TICK_WIDTH}" height="${TICK_HEIGHT}" rx="${TICK_RADIUS}" fill="${neutralFill}" fill-opacity="${hasScore ? '0.08' : '0.06'}" stroke="${neutralStroke}" stroke-width="1" stroke-opacity="${hasScore ? '0.3' : '0.24'}" />`
        );

        if (!shouldFill) {
            continue;
        }

        layers.push(
            `<rect x="${toSvgNumber(tickX)}" y="${toSvgNumber(tickY)}" width="${TICK_WIDTH}" height="${TICK_HEIGHT}" rx="${TICK_RADIUS}" fill="${TICK_FILLED}" fill-opacity="0.62" />`
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
    const bandCount = 5;
    const bandThickness = (WHEEL_OUTER_RADIUS - WHEEL_INNER_RADIUS) / bandCount;
    const bandGap = 0.8;
    const sliceAngle = (Math.PI * 2) / AXIS_SPECS.length;
    const baseStartAngle = (-3 * Math.PI) / 4;
    const sliceGapAngle = 1.2 / WHEEL_OUTER_RADIUS;
    const epsilon = 0.0001;
    const wheelLayers: string[] = [];
    const metadataLayers: string[] = [];

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
        if (score === undefined) {
            wheelLayers.push(
                `<path d="${sectorPath(WHEEL_CENTER_X, WHEEL_CENTER_Y, WHEEL_OUTER_RADIUS, startAngle, endAngle)}" fill="${MISSING_FILL}" fill-opacity="0.45" />`
            );
            continue;
        }

        const scoreProgress = score / bandCount;

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
        renderScoreRow(row, metadataLayers);
    }

    const outerRing = `<circle cx="${toSvgNumber(WHEEL_CENTER_X)}" cy="${toSvgNumber(WHEEL_CENTER_Y)}" r="${toSvgNumber(WHEEL_OUTER_RADIUS)}" fill="none" stroke="${OUTER_RING_STROKE}" stroke-width="0.6" stroke-opacity="0.7" />`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="TRACE card">`,
        '<title>TRACE card</title>',
        '<desc>TRACE wheel with Evidence and Freshness metadata bars. Missing TRACE axes render in red; missing chip values render gray.</desc>',
        ...wheelLayers,
        outerRing,
        ...metadataLayers,
        '</svg>',
    ]
        .filter((line) => line.length > 0)
        .join('\n');
};
