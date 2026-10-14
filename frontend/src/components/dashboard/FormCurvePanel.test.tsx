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
const curve: FormCurve = { today, goal_id: null, series: history, race_day: null, planned_sessions: 0, key_session: null };

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const mount = (ready = true) =>
  render(
    <QueryClientProvider client={client}>
      <FormCurvePanel day={today} ready={ready} />
    </QueryClientProvider>
  );

it('shows a skeleton, then the curve with its summary in words', async () => {
  vi.spyOn(formCurveApi, 'get').mockResolvedValue(curve);
  mount();
  expect(screen.getByRole('status', { name: 'Chargement de la courbe de forme' })).toBeTruthy();
  const caption = await screen.findByText(/^Sur 12 semaines/);
  expect(caption.textContent).toBe('Sur 12 semaines, ta forme de fond est passée de 32 à 40. Aujourd’hui : fatigue 36, forme +5.');
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

it('adds race morning to the summary when a race is projected', () => {
  const projected: FormCurve = {
    ...curve,
    goal_id: 3,
    series: [...history, { date: '2026-11-20', ctl: 45, atl: 38, tsb: 7, planned: true }],
    race_day: { ctl: 45.4, tsb: 8.6 },
  };
  expect(curveSummary(projected)).toMatch(/Projection le jour J : forme de fond 45, forme entre \+4 et \+14\.$/);
  expect(curveSummary({ ...curve, series: [] })).toMatch(/^Pas encore de charge/);
});
