/**
 * @description: Renders the experimental TRACE preview card as an SVG string for Discord attachments.
 * @footnote-scope: interface
 * @footnote-module: TracePreviewSvgRenderer
 * @footnote-risk: low - Rendering failures only affect the isolated experimental preview command.
 * @footnote-ethics: medium - TRACE visuals communicate reasoning posture, so misleading output can affect trust.
 */
import type {
    ResponseTemperament,
    TraceAxisScore,
    RiskTier,
} from '@footnote/contracts/ethics-core';

type TraceAxisKey = keyof ResponseTemperament;

type TraceAxisSpec = {
    key: TraceAxisKey;
    label: 'T' | 'R' | 'A' | 'C' | 'E';
    color: `#${string}`;
};

/**
 * Optional chip metadata rendered on the right side of the preview card.
 */
export interface TracePreviewChipData {
    confidencePercent?: number;
    riskTier?: RiskTier;
    tradeoffCount?: number;
}

/**
 * Input contract for SVG preview rendering.
 * Width/height are optional so callers can use a stable default card size.
 */
export interface TracePreviewRenderInput {
    temperament: ResponseTemperament;
    chips?: TracePreviewChipData;
    width?: number;
    height?: number;
}

const AXIS_SPECS: TraceAxisSpec[] = [
    { key: 'tightness', label: 'T', color: '#2F80ED' },
    { key: 'rationale', label: 'R', color: '#F2994A' },
    { key: 'attribution', label: 'A', color: '#27AE60' },
    { key: 'caution', label: 'C', color: '#EB5757' },
    { key: 'extent', label: 'E', color: '#00A3A3' },
];

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 80;
const CARD_FILL = '#0B1220';
const CARD_STROKE = '#1F2937';
const DIVIDER_STROKE = '#D1D5DB';
const LABEL_TEXT = '#F9FAFB';
const CHIP_FILL = '#111827';
const CHIP_STROKE = '#374151';
const CHIP_TEXT = '#E5E7EB';
const META_TEXT = '#93A4BC';

const RISK_TIER_COLORS: Record<RiskTier, `#${string}`> = {
    Low: '#7FDCA4',
    Medium: '#F8E37C',
    High: '#E27C7C',
};

/**
 * Bounds a numeric value to a closed interval.
 */
const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

/**
 * Normalizes a numeric candidate into an integer inside a closed interval.
 * Falls back to a caller-provided default when the candidate is not finite.
 */
const clampInt = (
    value: number,
    min: number,
    max: number,
    fallback: number
): number => {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return clamp(Math.round(value), min, max);
};

/**
 * Formats numbers for SVG attributes with predictable compact output.
 */
const toSvgNumber = (value: number): string => {
    const fixed = value.toFixed(2);
    return fixed.replace(/\.00$/, '');
};

/**
 * Escapes user-facing strings before inserting text into raw SVG XML.
 */
const escapeXml = (value: string): string =>
    value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');

/**
 * Parses a two-character hexadecimal channel value into a decimal channel.
 */
const parseHexChannel = (value: string): number => parseInt(value, 16);

/**
 * Parses a hex color string into RGB channels.
 * Supports short (`#abc`) and long (`#aabbcc`) forms.
 */
const parseHexColor = (hex: `#${string}`): [number, number, number] => {
    const normalized =
        hex.length === 4
            ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
            : hex;
    const r = parseHexChannel(normalized.slice(1, 3));
    const g = parseHexChannel(normalized.slice(3, 5));
    const b = parseHexChannel(normalized.slice(5, 7));
    return [r, g, b];
};

/**
 * Converts RGB channel values back into a hex color string.
 */
const toHexColor = (r: number, g: number, b: number): `#${string}` => {
    const channelToHex = (value: number): string =>
        clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
    return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
};

/**
 * Linearly blends two hex colors and returns the mixed color.
 */
const mixHexColors = (
    foreground: `#${string}`,
    background: `#${string}`,
    foregroundRatio: number
): `#${string}` => {
    const ratio = clamp(foregroundRatio, 0, 1);
    const [fr, fg, fb] = parseHexColor(foreground);
    const [br, bg, bb] = parseHexColor(background);
    return toHexColor(
        fr * ratio + br * (1 - ratio),
        fg * ratio + bg * (1 - ratio),
        fb * ratio + bb * (1 - ratio)
    );
};

/**
 * Builds a muted axis fill color for unfilled wheel regions.
 */
const mutedAxisColor = (color: `#${string}`): `#${string}` =>
    mixHexColors(color, CARD_FILL, 0.38);

/**
 * Converts polar coordinates to Cartesian coordinates for SVG path math.
 */
const polarPoint = (
    cx: number,
    cy: number,
    radius: number,
    angle: number
): { x: number; y: number } => ({
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
});

/**
 * Creates an SVG path for a ring-sector slice.
 * Used for each wheel band in every TRACE axis slice.
 */
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
 * Normalizes temperament values to the expected 1..10 integer range.
 * Invalid values fail open to a neutral midpoint (5).
 */
const normalizeTemperament = (
    temperament: ResponseTemperament
): ResponseTemperament => {
    const normalizeAxis = (value: number): TraceAxisScore =>
        clampInt(value, 1, 10, 5) as TraceAxisScore;

    return {
        tightness: normalizeAxis(temperament.tightness),
        rationale: normalizeAxis(temperament.rationale),
        attribution: normalizeAxis(temperament.attribution),
        caution: normalizeAxis(temperament.caution),
        extent: normalizeAxis(temperament.extent),
    };
};

/**
 * Normalizes optional chip metadata and limits output to at most three chips.
 */
const normalizeChips = (chips: TracePreviewChipData | undefined): string[] => {
    const normalized: string[] = [];
    const confidence = chips?.confidencePercent;
    const riskTier = chips?.riskTier;
    const tradeoffs = chips?.tradeoffCount;

    if (typeof confidence === 'number' && Number.isFinite(confidence)) {
        normalized.push(`CONF ${Math.round(clamp(confidence, 0, 100))}%`);
    }
    if (riskTier) {
        normalized.push(`RISK ${riskTier}`);
    }
    if (typeof tradeoffs === 'number' && Number.isFinite(tradeoffs)) {
        normalized.push(`TRADEOFFS ${Math.max(0, Math.round(tradeoffs))}`);
    }

    if (normalized.length === 0) {
        normalized.push('TRACE PREVIEW');
    }

    return normalized.slice(0, 3);
};

/**
 * Renders a compact TRACE preview SVG card from manual temperament and chip data.
 */
export function renderTracePreviewSvg(input: TracePreviewRenderInput): string {
    const width = Math.max(320, Math.round(input.width ?? DEFAULT_WIDTH));
    const height = Math.max(72, Math.round(input.height ?? DEFAULT_HEIGHT));
    const normalizedTemperament = normalizeTemperament(input.temperament);
    const chips = normalizeChips(input.chips);

    // Wheel geometry: center point, ring thickness, and slice math.
    const wheelCenterX = 40;
    const wheelCenterY = height / 2;
    const innerRadius = 8;
    const outerRadius = Math.min(30, height / 2 - 8);
    const bandCount = 5;
    const bandThickness = (outerRadius - innerRadius) / bandCount;
    const sliceAngle = (Math.PI * 2) / AXIS_SPECS.length;
    const baseStartAngle = -Math.PI / 2;
    const epsilon = 0.001;

    const wheelLayers: string[] = [];
    const dividerLines: string[] = [];
    const axisLabels: string[] = [];

    // Band fill math: each axis slice paints muted bands, then overlays filled progress.
    for (let index = 0; index < AXIS_SPECS.length; index += 1) {
        const axis = AXIS_SPECS[index];
        const startAngle = baseStartAngle + index * sliceAngle;
        const endAngle = startAngle + sliceAngle;
        const score = normalizedTemperament[axis.key];
        const scoreProgress = score / 10;
        const mutedColor = mutedAxisColor(axis.color);

        for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
            const bandStart = bandIndex / bandCount;
            const bandEnd = (bandIndex + 1) / bandCount;
            const bandInner = innerRadius + bandIndex * bandThickness;
            const bandOuter = bandInner + bandThickness;

            wheelLayers.push(
                `<path d="${ringSectorPath(wheelCenterX, wheelCenterY, bandInner, bandOuter, startAngle, endAngle)}" fill="${mutedColor}" />`
            );

            if (scoreProgress <= bandStart + epsilon) {
                continue;
            }

            const bandFillFraction = clamp(
                (scoreProgress - bandStart) / (bandEnd - bandStart),
                0,
                1
            );
            const filledOuter = bandInner + bandThickness * bandFillFraction;
            if (filledOuter <= bandInner + epsilon) {
                continue;
            }

            wheelLayers.push(
                `<path d="${ringSectorPath(wheelCenterX, wheelCenterY, bandInner, filledOuter, startAngle, endAngle)}" fill="${axis.color}" />`
            );
        }

        const dividerStart = polarPoint(
            wheelCenterX,
            wheelCenterY,
            innerRadius,
            startAngle
        );
        const dividerEnd = polarPoint(
            wheelCenterX,
            wheelCenterY,
            outerRadius,
            startAngle
        );
        dividerLines.push(
            `<line x1="${toSvgNumber(dividerStart.x)}" y1="${toSvgNumber(dividerStart.y)}" x2="${toSvgNumber(dividerEnd.x)}" y2="${toSvgNumber(dividerEnd.y)}" stroke="${DIVIDER_STROKE}" stroke-width="0.8" stroke-opacity="0.9" />`
        );

        const labelAngle = startAngle + sliceAngle / 2;
        const labelPoint = polarPoint(
            wheelCenterX,
            wheelCenterY,
            outerRadius + 8,
            labelAngle
        );
        axisLabels.push(
            `<text x="${toSvgNumber(labelPoint.x)}" y="${toSvgNumber(labelPoint.y)}" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="700" fill="${LABEL_TEXT}">${axis.label}</text>`
        );
    }

    dividerLines.push(
        `<circle cx="${toSvgNumber(wheelCenterX)}" cy="${toSvgNumber(wheelCenterY)}" r="${toSvgNumber(innerRadius)}" fill="none" stroke="${DIVIDER_STROKE}" stroke-width="0.8" stroke-opacity="0.9" />`
    );
    dividerLines.push(
        `<circle cx="${toSvgNumber(wheelCenterX)}" cy="${toSvgNumber(wheelCenterY)}" r="${toSvgNumber(outerRadius)}" fill="none" stroke="${DIVIDER_STROKE}" stroke-width="0.8" stroke-opacity="0.65" />`
    );

    // Chip layout: right-side metadata rows with risk-colored status dots.
    const chipStartX = 86;
    const chipWidth = Math.max(140, width - chipStartX - 10);
    const chipHeight = 16;
    const chipGap = 6;
    const totalChipHeight = chips.length * chipHeight + (chips.length - 1) * chipGap;
    const firstChipY = Math.round((height - totalChipHeight) / 2);
    const chipRows: string[] = [];

    for (let index = 0; index < chips.length; index += 1) {
        const text = chips[index];
        const y = firstChipY + index * (chipHeight + chipGap);
        const riskColor =
            text.startsWith('RISK ') && input.chips?.riskTier
                ? RISK_TIER_COLORS[input.chips.riskTier]
                : '#60A5FA';

        chipRows.push(
            `<rect x="${chipStartX}" y="${y}" width="${chipWidth}" height="${chipHeight}" rx="7" fill="${CHIP_FILL}" stroke="${CHIP_STROKE}" stroke-width="1" />`
        );
        chipRows.push(
            `<circle cx="${chipStartX + 8}" cy="${y + chipHeight / 2}" r="2.6" fill="${riskColor}" />`
        );
        chipRows.push(
            `<text x="${chipStartX + 15}" y="${toSvgNumber(y + chipHeight / 2)}" text-anchor="start" dominant-baseline="central" font-family="ui-sans-serif, system-ui, sans-serif" font-size="9" font-weight="600" fill="${CHIP_TEXT}">${escapeXml(text)}</text>`
        );
    }

    const axisSummary = `T${normalizedTemperament.tightness} R${normalizedTemperament.rationale} A${normalizedTemperament.attribution} C${normalizedTemperament.caution} E${normalizedTemperament.extent}`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="TRACE preview">`,
        '<title>TRACE preview</title>',
        '<desc>Experimental TRACE wheel with compact metadata chips. This asset is not yet part of production provenance footers.</desc>',
        `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="11" fill="${CARD_FILL}" fill-opacity="0.92" stroke="${CARD_STROKE}" stroke-width="1" />`,
        ...wheelLayers,
        ...dividerLines,
        ...axisLabels,
        ...chipRows,
        `<text x="${chipStartX}" y="${height - 8}" text-anchor="start" dominant-baseline="central" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="8" fill="${META_TEXT}">${escapeXml(axisSummary)}</text>`,
        '</svg>',
    ].join('\n');
}
