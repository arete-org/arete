// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Records } from '@/types';
import { RecordsCard } from './RecordsCard';

afterEach(cleanup);

const empty: Records = { runs: [], lifts: [], runs_scanned: 0, runs_limit: 100, sessions_limit: 100 };

function show(records?: Records, state: { loading?: boolean; error?: boolean } = {}) {
  render(
    <MemoryRouter>
      <RecordsCard records={records} {...state} />
    </MemoryRouter>,
  );
}

it('says what is missing when there is no Garmin run or logged lift', () => {
  show(empty);
  expect(screen.getByText(/il faut une course d’au moins 1 km enregistrée avec la montre/)).toBeTruthy();
  expect(screen.getByText(/enregistre une séance de force avec ses séries/)).toBeTruthy();
  expect(screen.getByText(/sur tes 100 dernières courses/)).toBeTruthy();
});

it('links each running record to its session and shows the best lift', () => {
  show({
    ...empty,
    runs: [
      { name: '5 km', distance_m: 5000, time_sec: 1330, time_display: '22:10', pace_display: '4:26 /km', date: '2026-09-20', session_id: 9, session_name: 'Tempo' },
    ],
    lifts: [{ exercise: 'Squat', e1rm_kg: 116.7, weight_kg: 100, reps: 5, date: '2026-10-10', session_id: 30, sessions: 14 }],
    runs_scanned: 1,
  });
  const link = screen.getByRole('link', { name: '5 km en 22:10, voir la séance « Tempo »' });
  expect(link.getAttribute('href')).toBe('/log/sessions/9');
  expect(screen.getByRole('rowheader', { name: 'Squat' })).toBeTruthy();
  expect(screen.getByText('116,7 kg')).toBeTruthy();
  expect(screen.getByText('5 × 100 kg')).toBeTruthy();
});

it('keeps the loading and failure states of the other cards', () => {
  show(undefined, { loading: true });
  expect(screen.getByText('Chargement…')).toBeTruthy();
  cleanup();
  show(undefined, { error: true });
  expect(screen.getByText('Données indisponibles')).toBeTruthy();
});
