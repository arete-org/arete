// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ContextWindowGauge } from './ContextWindowGauge';

afterEach(cleanup);
function gauge(used?: number, compacting = false, query = '') {
  return render(<MemoryRouter initialEntries={[`/${query}`]}>
    <ContextWindowGauge usage={used === undefined ? undefined : { used_tokens: used, window_tokens: 1000 }} compacting={compacting} />
  </MemoryRouter>);
}

it('requires real counters even with the URL flag or compaction signal', () => {
  gauge(undefined, true, '?contextGaugeAlways');
  expect(screen.queryByRole('button')).toBeNull();
});

it('hides low usage by default but treats the URL flag as presence only', () => {
  gauge(840);
  expect(screen.queryByRole('button')).toBeNull();
  cleanup();
  gauge(320, false, '?contextGaugeAlways=false');
  expect(screen.getByRole('button', { name: 'Contexte · 32 %' })).toBeTruthy();
  expect(document.querySelector('.text-success-green')).toBeTruthy();
});

it.each([[850, 'warning-orange', '85'], [999, 'warning-orange', '100'], [1200, 'danger-red', '100']])('shows thresholds and caps only the displayed percentage (%i)', (used, color, percent) => {
  gauge(Number(used));
  expect(screen.getByRole('button', { name: `Contexte · ${percent} %` })).toBeTruthy();
  expect(document.querySelector(`.text-${color}`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('tooltip').textContent).toContain(new Intl.NumberFormat('fr-FR').format(Number(used)));
  fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('shows compaction below the visibility threshold and removes it when done', () => {
  const view = gauge(500, true);
  expect(screen.getByRole('button', { name: 'Compaction…' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('en cours');
  view.rerender(<MemoryRouter><ContextWindowGauge usage={{ used_tokens: 500, window_tokens: 1000 }} compacting={false} /></MemoryRouter>);
  expect(screen.queryByRole('button')).toBeNull();
});
