/**
 * @description: Renders canonical TRACE card SVG assets for storage and cross-surface reuse.
 * @footnote-scope: core
 * @footnote-module: TraceCardSvgRenderer
 * @footnote-risk: medium - Rendering regressions can distort provenance visuals across Discord and web surfaces.
 * @footnote-ethics: medium - TRACE visuals shape user trust in how model behavior is communicated.
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
 * Optional chip metadata rendered to the right of the TRACE wheel.
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
    { key: 'tightness', label: 'T', color: '#2F80ED' }, //
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

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

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

const toSvgNumber = (value: number): string => {
    const fixed = value.toFixed(2);
    return fixed.replace(/\.00$/, '');
};

const escapeXml = (value: string): string =>
    value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');

const parseHexChannel = (value: string): number => parseInt(value, 16);

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

const toHexColor = (r: number, g: number, b: number): `#${string}` => {
    const channelToHex = (value: number): string =>
        clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
    return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
};

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

const mutedAxisColor = (color: `#${string}`): `#${string}` =>
    mixHexColors(color, CARD_FILL, 0.38);

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
 * Normalizes axis values to integer 1..10 and fails open to midpoint 5.
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
 * Normalizes optional chip values and limits output to three rows.
 */
const normalizeChips = (chips: TraceCardChipData | undefined): string[] => {
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
        normalized.push('TRACE CARD');
    }

    return normalized.slice(0, 3);
};

/**
 * Renders canonical trace-card SVG for storage and downstream conversion.
 */
export const renderTraceCardSvg = (input: TraceCardRenderInput): string => {
    const width = Math.max(320, Math.round(input.width ?? DEFAULT_WIDTH));
    const height = Math.max(72, Math.round(input.height ?? DEFAULT_HEIGHT));
    const normalizedTemperament = normalizeTemperament(input.temperament);
    const chips = normalizeChips(input.chips);

    // Wheel
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

    // Right-side chip rows (compact by design to keep the card height stable)
    const chipStartX = 86;
    const chipWidth = Math.max(140, width - chipStartX - 10);
    const chipHeight = 16;
    const chipGap = 6;
    const totalChipHeight =
        chips.length * chipHeight + (chips.length - 1) * chipGap;
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
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="TRACE card">`,
        '<title>TRACE card</title>',
        '<desc>TRACE wheel with compact chip metadata for provenance display.</desc>',
        `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="11" fill="${CARD_FILL}" fill-opacity="0.92" stroke="${CARD_STROKE}" stroke-width="1" />`,
        ...wheelLayers,
        ...dividerLines,
        ...axisLabels,
        ...chipRows,
        `<text x="${chipStartX}" y="${height - 8}" text-anchor="start" dominant-baseline="central" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="8" fill="${META_TEXT}">${escapeXml(axisSummary)}</text>`,
        '</svg>',
    ].join('\n');
};
