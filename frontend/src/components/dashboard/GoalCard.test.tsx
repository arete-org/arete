// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { formCurveApi, type FormCurve } from '@/lib/formCurve';
import type { Goal } from '@/types';
import { GoalCard } from './GoalCard';

const goal: Goal = {
  id: 3, name: 'Semi de Lyon', race_date: '2026-11-23', distance_km: 21.1, target_time_sec: 5400,
  priority: 'A', status: 'active', days_left: 40, created_at: null,
};
const curve: FormCurve = {
  today: '2026-10-14', goal_id: 3, planned_sessions: 12,
  series: [{ date: '2026-10-14', ctl: 40, atl: 36, tsb: 4, planned: false }],
  race_day: { ctl: 45.2, tsb: 8.4 },
  key_session: { id: 9, date: '2026-10-16', session_type: 'intervals', description: '6 x 1000 m', target_duration_min: 60 },
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const mount = (props: Parameters<typeof GoalCard>[0]) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GoalCard {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );

it('leads with the race: countdown, a form band on race day and the key session', async () => {
  const read = vi.spyOn(formCurveApi, 'get').mockResolvedValue(curve);
  mount({ goal, day: '2026-10-14', ready: true });
  expect(screen.getByRole('region', { name: 'Objectif de course' })).toBeTruthy();
  expect(screen.getByText('Semi de Lyon')).toBeTruthy();
  expect(screen.getByText('J-40')).toBeTruthy();
  // A band, not false precision.
  expect(await screen.findByText('entre +3 et +13')).toBeTruthy();
  const key = screen.getByRole('link', { name: /Séance clé : .* · Fractionné · 60 min/ });
  expect(key.getAttribute('href')).toBe('/planning?date=2026-10-16');
  expect(read).toHaveBeenCalledTimes(1);
});

it('waits for the dashboard before reading the projection', () => {
  const read = vi.spyOn(formCurveApi, 'get').mockResolvedValue(curve);
  mount({ goal, day: '2026-10-14', ready: false });
  expect(screen.getByText('J-40')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Projection du jour J…');
  expect(read).not.toHaveBeenCalled();
});

it('offers to set a goal when there is none, without reading the curve', () => {
  const read = vi.spyOn(formCurveApi, 'get');
  mount({ goal: null, day: '2026-10-14', ready: true });
  const link = screen.getByRole('link', { name: 'Fixer un objectif' });
  expect(link.getAttribute('href')).toBe('/settings?tab=goals');
  expect(screen.queryByRole('region', { name: 'Objectif de course' })).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it('treats a race already run as no goal, and offers the next one', () => {
  const read = vi.spyOn(formCurveApi, 'get');
  mount({ goal: { ...goal, days_left: -2 }, day: '2026-10-14', ready: true });
  expect(screen.getByText('Ta course est passée.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Fixer le prochain objectif' })).toBeTruthy();
  expect(screen.queryByText(/J-/)).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it('says race day, and never projects for another goal than the shown one', async () => {
  vi.spyOn(formCurveApi, 'get').mockResolvedValue({ ...curve, goal_id: 99 });
  mount({ goal: { ...goal, days_left: 0 }, day: '2026-10-14', ready: true });
  expect(screen.getByText('Jour J')).toBeTruthy();
  await vi.waitFor(() => expect(client.getQueryState(['form-curve', '2026-10-14'])?.status).toBe('success'));
  expect(screen.queryByText(/entre/)).toBeNull();
});
