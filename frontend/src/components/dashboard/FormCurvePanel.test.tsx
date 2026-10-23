// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { curveSummary, formCurveApi, type FormCurve } from '@/lib/formCurve';
import { FormCurvePanel } from './FormCurvePanel';

const history = Array.from({ length: 85 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 21 + i));
  return { date: d.toISOString().slice(0, 10), ctl: 32 + i * 0.1, atl: 30 + i * 0.07, tsb: 2 + i * 0.03, planned: false };
});
const today = history[84].date; // 2026-10-13
const curve: FormCurve = { today, goal_id: null, series: history, race_day: null, planned_sessions: 0, last_planned: null, key_session: null };

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const retry = vi.fn();
const mount = (ready = true, { hasLoad = true as boolean | undefined, failed = false } = {}) =>
  render(
    <QueryClientProvider client={client}>
      <FormCurvePanel day={today} ready={ready} hasLoad={hasLoad} failed={failed} retry={retry} />
    </QueryClientProvider>
  );

it('shows a skeleton, then the curve with its summary in words', async () => {
  vi.spyOn(formCurveApi, 'get').mockResolvedValue(curve);
  mount();
  expect(screen.getByRole('status', { name: 'Chargement de la courbe de forme' })).toBeTruthy();
  const caption = await screen.findByText(/^Sur 12 semaines/);
  expect(caption.textContent).toBe('Sur 12 semaines, ta forme de fond est passée de 32 à 40. Aujourd’hui : fatigue 36, fraîcheur +5.');
  expect(caption.tagName).toBe('FIGCAPTION');
  // No acronym in the words the athlete reads.
  expect(screen.queryAllByText(/\b(CTL|ATL|TSB)\b/)).toHaveLength(0);
});

it('reads nothing before the dashboard answers', () => {
  const read = vi.spyOn(formCurveApi, 'get').mockResolvedValue(curve);
  mount(false);
  expect(read).not.toHaveBeenCalled();
});

it('says when there is no load yet, and when the read failed', async () => {
  vi.spyOn(formCurveApi, 'get').mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ...curve, series: [] });
  mount();
  expect(await screen.findByText(/Courbe indisponible/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(await screen.findByText(/Pas encore de charge enregistrée/)).toBeTruthy();
});

it('adds race morning to the summary only when the plan reaches race week', () => {
  const projected: FormCurve = {
    ...curve,
    goal_id: 3,
    series: [...history, { date: '2026-11-20', ctl: 45, atl: 38, tsb: 7, planned: true }],
    race_day: { ctl: 45.4, tsb: 8.6 },
    last_planned: '2026-11-18',
  };
  // 38 days out: ±5.
  expect(curveSummary(projected)).toMatch(/Projection le jour J : forme de fond 45, fraîcheur entre \+4 et \+14\.$/);
  expect(curveSummary({ ...projected, last_planned: '2026-10-25' })).toMatch(/Plan jusqu’au 25 oct\., la courbe suppose du repos ensuite\.$/);
  expect(curveSummary({ ...curve, series: [] })).toMatch(/^Pas encore de charge/);
});

it('reads today from the logged load, the projection after it', () => {
  // The server sends today from the load only: its point is the dashboard's form.
  const withPlanToday: FormCurve = {
    ...curve,
    goal_id: 3,
    last_planned: '2026-11-18',
    race_day: { ctl: 45, tsb: 8 },
    series: [...history, { date: '2026-10-14', ctl: 41, atl: 45, tsb: -4, planned: true }],
  };
  expect(curveSummary(withPlanToday)).toContain('Aujourd’hui : fatigue 36, fraîcheur +5.');
});

it('fails with the dashboard, with its retry, and reads nothing', () => {
  const read = vi.spyOn(formCurveApi, 'get');
  mount(false, { failed: true, hasLoad: undefined });
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(retry).toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it('has nothing to draw nor read without any load', () => {
  const read = vi.spyOn(formCurveApi, 'get');
  mount(true, { hasLoad: false });
  expect(screen.getByText(/Pas encore de charge enregistrée/)).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
});

it('keeps the settled height while it loads', () => {
  vi.spyOn(formCurveApi, 'get').mockReturnValue(new Promise(() => {}));
  mount();
  expect(screen.getByRole('status', { name: 'Chargement de la courbe de forme' }).parentElement?.className).toContain('min-h-[19rem]');
});
