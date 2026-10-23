// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { BodyReport } from '@/lib/bodyLog';
import { Report } from './HealthReport';

afterEach(cleanup);

const weeks = Array.from({ length: 8 }, (_, i) => {
  const start = new Date(2026, 7, 31 + i * 7);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { week_start: iso(start), week_end: iso(end), sessions: 0, duration_min: 0, distance_km: 0, tss: 0, acwr: null };
});

const empty: BodyReport = {
  start: '2026-08-31', end: '2026-10-22', weeks, sessions: [], pain: [], pain_areas: [], weights: [],
  weight: { latest: null, average_7d: null, change_kg: null, change_since: null },
  readiness: [], checkins: [], totals: { sessions: 0, duration_min: 0, pain_entries: 0, max_pain: null },
};

const section = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement;

it('renders eight weeks and says what is missing when there is no data', () => {
  render(<Report report={empty} today="2026-10-22" />);
  expect(screen.getByRole('heading', { level: 1, name: 'Rapport d’entraînement et de santé' })).toBeTruthy();
  expect(screen.getByText(/Du 31 août 2026 au 22 octobre 2026 · 8 semaines/)).toBeTruthy();
  expect(screen.getByText(/Établi par Arete le 22 octobre 2026.+n’est pas un avis médical/)).toBeTruthy();
  expect(within(section('Charge hebdomadaire')).getAllByRole('row')).toHaveLength(9);
  expect(within(section('Douleurs')).getByText('Aucune douleur notée sur la période.')).toBeTruthy();
  expect(within(section('Poids')).getByText('Aucun poids noté sur la période.')).toBeTruthy();
  expect(within(section('Préparation et sommeil')).getByText('Aucune mesure de la montre sur la période.')).toBeTruthy();
  expect(within(section('Check-ins du matin')).getByText('Aucun check-in sur la période.')).toBeTruthy();
  expect(within(section('Séances')).getByText('Aucune séance sur la période.')).toBeTruthy();
});

it('prints the pain with its notes, the weight, the readiness, the check-ins and the sessions', () => {
  const pain = {
    id: 1, date: '2026-10-20', area: 'knee' as const, side: 'left' as const, intensity: 6, note: 'en descente',
    label: 'genou, côté gauche', created_at: '', updated_at: '',
  };
  render(
    <Report
      athlete="Greg"
      today="2026-10-22"
      report={{
        ...empty,
        weeks: weeks.map((w, i) => (i === 7 ? { ...w, sessions: 1, duration_min: 50, distance_km: 10, tss: 48, acwr: 1.38 } : w)),
        sessions: [{ date: '2026-10-20', kind: 'cardio', sport: 'running', duration_min: 50, distance_km: 10, avg_hr: 140, rpe: 4, tss: 48 }],
        pain: [pain],
        pain_areas: [{ area: 'knee', side: 'left', label: 'genou, côté gauche', last_date: '2026-10-20', last_intensity: 6, max_intensity: 6, entries: 1 }],
        weights: [
          { date: '2026-10-01', weight_kg: 72.2, source: 'manual', created_at: '', updated_at: '' },
          { date: '2026-10-20', weight_kg: 71.4, source: 'manual', created_at: '', updated_at: '' },
        ],
        weight: { latest: { date: '2026-10-20', weight_kg: 71.4, source: 'manual', created_at: '', updated_at: '' }, average_7d: 71.4, change_kg: -0.8, change_since: '2026-10-01' },
        readiness: [{ date: '2026-10-20', garmin_readiness: 62, readiness: null, sleep_score: 80, resting_hr: 48, hrv: 55 }],
        checkins: [{ date: '2026-10-20', sleep: 2, legs: 3, mood: null }],
        totals: { sessions: 1, duration_min: 50, pain_entries: 1, max_pain: 6 },
      }}
    />,
  );
  expect(screen.getByText(/· Greg$/)).toBeTruthy();
  expect(screen.getByText('1 (max 6/10)')).toBeTruthy();
  expect(within(section('Charge hebdomadaire')).getByText('1,38')).toBeTruthy();
  const hurts = section('Douleurs');
  expect(within(hurts).getByText('en descente')).toBeTruthy();
  expect(within(hurts).getAllByText('6/10').length).toBeGreaterThan(0);
  expect(within(section('Poids')).getByRole('img', { name: /de 72,2 kg le 1 oct\. à 71,4 kg le 20 oct\./ })).toBeTruthy();
  expect(within(section('Poids')).getByText('71,4 kg le 20 oct. (−0,8 kg depuis le 1 oct.)')).toBeTruthy();
  expect(within(section('Préparation et sommeil')).getByText('62/100')).toBeTruthy();
  expect(within(section('Check-ins du matin')).getByText('2/5')).toBeTruthy();
  expect(within(section('Séances')).getByText('Course')).toBeTruthy();
});
