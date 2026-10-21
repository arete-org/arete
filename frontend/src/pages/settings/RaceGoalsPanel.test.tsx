// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { goalsApi } from '@/lib/api';
import type { Goal, PlanWeek } from '@/types';
import { PlanWeekList } from './PlanPreviewModal';
import { RaceGoalsPanel } from './RaceGoalsPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const goal: Goal = {
  id: 1,
  name: 'Semi de Paris',
  race_date: '2027-03-07',
  distance_km: 21.1,
  target_time_sec: 6300,
  priority: 'A',
  status: 'active',
  days_left: 149,
  created_at: null,
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RaceGoalsPanel />
    </QueryClientProvider>
  );
  return client;
}

it('shows each week with its French phase, minutes and recovery flag', () => {
  const weeks: PlanWeek[] = [
    {
      start: '2026-10-12',
      phase: 'build',
      minutes: 240,
      recovery: true,
      sessions: [
        {
          date: '2026-10-14',
          session_type: 'intervals',
          duration_min: 50,
          hr_zone: 'Z4',
          intensity: 'hard',
          description: '6×800 m',
          distance_km: null,
        },
      ],
    },
    { start: '2026-10-19', phase: 'taper', minutes: 150, recovery: false, sessions: [] },
  ];
  render(<PlanWeekList weeks={weeks} />);
  expect(screen.getByText('Développement')).toBeTruthy();
  expect(screen.getByText('Affûtage')).toBeTruthy();
  expect(screen.getByText('240 min')).toBeTruthy();
  expect(screen.getAllByText('allégée')).toHaveLength(1);
  expect(screen.getByText('Fractionné')).toBeTruthy();
  expect(screen.getByText('6×800 m')).toBeTruthy();
});

it('lists the goals with their countdown and target time', async () => {
  vi.spyOn(goalsApi, 'list').mockResolvedValue([goal]);
  const client = renderPanel();
  expect(await screen.findByText('Semi de Paris')).toBeTruthy();
  expect(screen.getByText('J-149')).toBeTruthy();
  expect(screen.getByText(/21,1 km · objectif 1:45:00/)).toBeTruthy();
  client.clear();
});

it('shows no distance for a hybrid block', async () => {
  const block: Goal = { ...goal, id: 2, name: 'Bloc hybride', distance_km: 0, target_time_sec: null, goal_type: 'hybrid' };
  vi.spyOn(goalsApi, 'list').mockResolvedValue([block]);
  const client = renderPanel();
  expect(await screen.findByText('Bloc hybride')).toBeTruthy();
  expect(screen.queryByText(/0 km/)).toBeNull();
  client.clear();
});

it('creates a goal from a distance chip and an h:mm:ss target', async () => {
  vi.spyOn(goalsApi, 'list').mockResolvedValue([]);
  const create = vi.spyOn(goalsApi, 'create').mockResolvedValue(goal);
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: /Ajouter une course/ }));
  fireEvent.change(screen.getByPlaceholderText('Semi de Paris'), { target: { value: 'Semi de Paris' } });
  fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: '2027-03-07' } });
  fireEvent.click(screen.getByRole('button', { name: '21,1' }));
  fireEvent.change(screen.getByPlaceholderText('1:45:00'), { target: { value: '1:4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter la course' }));
  expect(screen.getByRole('alert').textContent).toBe('Temps visé au format h:mm:ss.');
  fireEvent.change(screen.getByPlaceholderText('1:45:00'), { target: { value: '1:45:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'B' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter la course' }));
  await waitFor(() =>
    expect(create.mock.calls[0][0]).toEqual({
      name: 'Semi de Paris',
      race_date: '2027-03-07',
      distance_km: 21.1,
      target_time_sec: 6300,
      priority: 'B',
    })
  );
  client.clear();
});
