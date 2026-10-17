import contract from '../../../src/arete/services/chart_contract.json';

export const CHART_CONTRACT = contract;

export interface ChartCardData {
  version: 1;
  id: string;
  title: string;
  summary: string;
  html: string;
  height_px: number;
}
export interface ChartCardPart extends ChartCardData { kind: 'chart_card' }

/** Validate both transport and saved data before it can reach the renderer. */
export function isChartCard(value: unknown): value is ChartCardData {
  if (!value || typeof value !== 'object') return false;
  const card = value as Record<string, unknown>;
  return card.version === contract.version
    && typeof card.id === 'string' && /^[a-f0-9]{64}$/.test(card.id)
    && typeof card.title === 'string' && card.title.length <= 2 * contract.max_title_chars && card.title.trim().length > 0
    && [...card.title].length <= contract.max_title_chars
    && typeof card.summary === 'string' && card.summary.length <= 2 * contract.max_summary_chars && card.summary.trim().length > 0
    && [...card.summary].length <= contract.max_summary_chars
    && typeof card.html === 'string' && card.html.length > 0
    && card.html.length <= contract.max_html_bytes
    && new TextEncoder().encode(card.html).length <= contract.max_html_bytes
    && typeof card.height_px === 'number' && Number.isInteger(card.height_px)
    && card.height_px >= contract.height_min && card.height_px <= contract.height_max;
}

export function chartPart(card: ChartCardData): ChartCardPart {
  return { kind: 'chart_card', version: card.version, id: card.id, title: card.title,
    summary: card.summary, html: card.html, height_px: card.height_px };
}
