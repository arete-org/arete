// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { yearReviewApi, type YearReview } from '@/lib/yearReview';
import { YearReviewPage } from './YearReview';

const year = new Date().getFullYear();

function review(overrides: Partial<YearReview> = {}): YearReview {
  const session = { id: 1, date: `${year}-03-10`, sport: 'cycling', name: 'Col', duration_sec: 12000, distance_m: 60000, ascent_m: 1500, tss: 180 };
  return {
    year,
    start: `${year}-01-01`,
    end: `${year}-03-31`,
    complete: false,
    years: [year, year - 1],
    totals: { sessions: 42, duration_sec: 180000, distance_m: 512300, ascent_m: 8400, tss: 3100 },
    sports: [{ sport: 'running', sessions: 30, duration_sec: 120000, distance_m: 400000, pct_time: 66.7 }],
    months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, sessions: 3, duration_sec: 15000, distance_m: 40000, ascent_m: 700, tss: 250, strength_volume_kg: 0 })),
    consistency: { active_days: 40, days: 90, active_weeks: 12, weeks: 13, longest_day_streak: 5, longest_week_streak: 9 },
    highlights: { longest_distance: session, longest_duration: session, hardest: session, biggest_climb: session },
    records: {
      runs: [
        { name: '5 km', distance_m: 5000, time_sec: 1450, time_display: '24:10', pace_display: '4:50 /km', date: `${year}-01-04`, session_id: 2, session_name: 'Footing', previous_best: 1500, is_pr: true },
        { name: '10 km', distance_m: 10000, time_sec: 3100, time_display: '51:40', pace_display: '5:10 /km', date: `${year}-01-04`, session_id: 2, session_name: 'Footing', previous_best: 3000, is_pr: false },
      ],
      lifts: [
        { exercise_id: 3, exercise: 'Squat', e1rm_kg: 128.3, weight_kg: 110, reps: 5, date: `${year}-02-01`, session_id: 7, sessions: 9, previous_best: null, is_pr: true },
      ],
    },
    pr_count: 2,
    fitness: { series: [{ date: `${year}-01-07`, ctl: 30 }], peak: { date: `${year}-03-10`, ctl: 52.4 }, start_ctl: 28, end_ctl: 45 },
    strength: { sessions: 0, working_sets: 0, volume_kg: 0, top_exercises: [] },
    ...overrides,
  };
}

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

function show(path = '/analytics/bilan') {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <YearReviewPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

it('shows the current year by default, its totals and its records', async () => {
  const get = vi.spyOn(yearReviewApi, 'get').mockResolvedValue(review());
  show();
  expect(await screen.findByText('42')).toBeTruthy();
  expect(get).toHaveBeenCalledWith(year);
  expect(screen.getByRole('heading', { name: `Bilan ${year}` })).toBeTruthy();
  expect(screen.getByText('Record −50 s')).toBeTruthy();
  expect(screen.getByText('Première charge')).toBeTruthy();
  expect(screen.getByText(/^2 nouveaux records cette année/)).toBeTruthy();
  // Each record links to its session: a run's page, a log in the Journal.
  expect(screen.getAllByRole('link', { name: /Footing/ })[0].getAttribute('href')).toBe('/log/sessions/2');
  expect(screen.getByRole('link', { name: /5 × 110 kg/ }).getAttribute('href')).toBe('/log?session=7');
  expect(screen.getByText('12 / 13')).toBeTruthy();
  expect(screen.getByText('Aucune séance de force enregistrée.')).toBeTruthy();
});

it('switches year from the selector', async () => {
  const get = vi.spyOn(yearReviewApi, 'get').mockResolvedValue(review());
  show();
  await screen.findByText('42');
  fireEvent.change(screen.getByRole('combobox', { name: 'Année' }), { target: { value: String(year - 1) } });
  await waitFor(() => expect(get).toHaveBeenCalledWith(year - 1));
});

it('says so when the year holds no session', async () => {
  vi.spyOn(yearReviewApi, 'get').mockResolvedValue(
    review({ totals: { sessions: 0, duration_sec: 0, distance_m: 0, ascent_m: 0, tss: 0 } })
  );
  show(`/analytics/bilan?year=${year - 1}`);
  expect(await screen.findByText(`Aucune séance en ${year - 1}`)).toBeTruthy();
});
