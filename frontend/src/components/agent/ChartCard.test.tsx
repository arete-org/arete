// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ChartCard } from './ChartCard';
import { buildChartDocument } from '@/lib/chartDocument';
import type { ChartCardData } from '@/lib/chartCards';

const svg = '<svg viewBox="0 0 320 200" role="img" aria-label="Distance en kilomètres"><text class="chart-label" x="4" y="44">40 km</text><polyline class="series-blue chart-line" points="20,80 200,40"/></svg>';
const chart: ChartCardData = { version: 1, id: 'a'.repeat(64), title: 'Distance', summary: '20 puis 40 km sur deux semaines.', html: svg, height_px: 280 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.removeAttribute('style'); delete document.documentElement.dataset.theme; });

it('keeps a native accessible card around an opaque, offline frame', async () => {
  render(<ChartCard chart={chart} />);
  expect(screen.getByRole('figure', { name: 'Distance', description: chart.summary })).toBeTruthy();
  expect(screen.getByText(chart.summary)).toBeTruthy();
  const frame = await screen.findByTitle('Distance') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame.style.height).toBe('280px');
  expect(frame.srcdoc).toContain("default-src 'none'");
  expect(frame.srcdoc).toContain("script-src 'none'");
  expect(frame.srcdoc).toContain('viewBox="0 0 320 200"');
  expect(frame.srcdoc).toContain('>40 km</text>');
  expect(screen.getByRole('figure').querySelector('svg')).toBeNull();
});

it('updates the embedded palette when the active theme changes', async () => {
  document.documentElement.style.setProperty('--color-chart-blue', '#123456');
  render(<ChartCard chart={chart} />);
  const frame = await screen.findByTitle('Distance') as HTMLIFrameElement;
  expect(frame.srcdoc).toContain('--color-chart-blue:#123456');
  document.documentElement.style.setProperty('--color-chart-blue', '#abcdef');
  document.documentElement.dataset.theme = 'prune';
  await waitFor(() => expect(frame.srcdoc).toContain('--color-chart-blue:#abcdef'));
});

it.each([
  '<script>window.parent.pwned=true</script>', '<img src="https://example.com/pixel">',
  '<style>@import "https://example.com";</style>', '<a href="https://example.com">Sortir</a>',
  '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>',
  '<svg viewBox="0 0 10 10"><foreignObject><p>HTML</p></foreignObject></svg>',
  '<svg viewBox="0 0 10 10"><animate attributeName="href" values="https://example.com"/></svg>',
  '<svg viewBox="0 0 10 10"><path fill="url(https://example.com/pixel)"/></svg>',
  '<svg viewBox="0 0 10 10"><path style="fill:red"/></svg>',
  '<svg viewBox="0 0 10 10"><text class="unknown">Texte</text></svg>',
])('rejects active or unsupported content without displaying a partial chart: %s', input => {
  expect(() => buildChartDocument(svg + input)).toThrow();
});

it('preserves the summary when restored HTML fails validation', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(<ChartCard chart={{ ...chart, html: svg + '<script>bad()</script>' }} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText(chart.summary)).toBeTruthy();
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('script')).toBeNull();
});

it('enforces browser element and depth bounds before creating an iframe', () => {
  const root = '<svg viewBox="0 0 320 200">';
  expect(() => buildChartDocument(root + '<rect/>'.repeat(512) + '</svg>')).toThrow();
  expect(() => buildChartDocument(root + '<g>'.repeat(16) + '</g>'.repeat(16) + '</svg>')).toThrow();
  expect(() => buildChartDocument(root + '<g>'.repeat(15) + '</g>'.repeat(15) + '</svg>')).not.toThrow();
});
