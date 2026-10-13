// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActualSession, PlanDecision, PlannedSession } from '@/types';
import { SessionCard } from './SessionCard';

afterEach(cleanup);

const session: PlannedSession = {
  id: 7,
  date: '2026-10-09',
  sport: 'running',
  session_type: 'endurance',
  target_duration_min: 45,
  target_distance_km: null,
  target_hr_zone: 'Z2',
  target_intensity: 'easy',
  description: null,
  source: 'manual',
  status: 'modified',
  garmin_workout_id: null,
  garmin_pushed_at: null,
};

const decision = (over: Partial<PlanDecision> = {}): PlanDecision => ({
  id: 3,
  date: '2026-10-09',
  planned_session_id: 7,
  decision: 'ease',
  reason: 'Préparation Garmin 68/100 : seuil allégé en endurance Z2.',
  readiness_score: 68,
  readiness_source: 'garmin_training',
  acwr: 1.1,
  original: null,
  adapted: null,
  applied_at: '2026-10-09T06:00:00',
  reverted_at: null,
  created_at: '2026-10-09T06:00:00',
  ...over,
});

it('shows the decision, its reason and the modified chip', () => {
  render(<SessionCard planned={session} realised={null} state="pending" decision={decision()} />);
  expect(screen.getByText('Allégée')).toBeTruthy();
  expect(screen.getByText(/68\/100/)).toBeTruthy();
  expect(screen.getByText('modifiée')).toBeTruthy();
});

it('sends to Garmin, then says when it was sent rather than claiming the watch has it', () => {
  const onPush = vi.fn();
  const push = { text: "45' Z2", onPush, pending: false, error: null };
  const { rerender } = render(<SessionCard planned={session} realised={null} state="pending" push={push} />);
  fireEvent.click(screen.getByText('Envoyer sur la montre'));
  expect(onPush).toHaveBeenCalledOnce();

  rerender(
    <SessionCard
      planned={{ ...session, garmin_pushed_at: '2026-10-09T07:05:00' }}
      realised={null}
      state="pending"
      push={push}
    />
  );
  expect(screen.queryByText('Envoyer sur la montre')).toBeNull();
  expect(screen.getByText(/Envoyée à Garmin \d\d:\d\d/)).toBeTruthy();
});

it.each([
  ['a kept session', decision({ decision: 'keep' })],
  ['a reverted decision', decision({ reverted_at: '2026-10-09T08:00:00' })],
])('offers no revert for %s', (_label, d) => {
  render(<SessionCard planned={session} realised={null} state="pending" decision={d} onRevert={vi.fn()} />);
  expect(screen.queryByText('Rétablir la séance prévue')).toBeNull();
});

it('shows the exercises of the Muscu log on the Garmin activity that fulfils the session', () => {
  const garmin = {
    id: 30,
    date: '2026-10-09',
    sport: 'strength',
    name: 'Musculation',
    duration_sec: 3600,
    exercises: ['Squat', 'Développé couché'],
  } as ActualSession;
  render(<SessionCard planned={{ ...session, sport: 'strength', session_type: 'strength' }} realised={garmin} state="done" />);
  expect(screen.getByText('Musculation')).toBeTruthy();
  expect(screen.getByText('Squat · Développé couché')).toBeTruthy();
});

it('reverts an applied change', () => {
  const onRevert = vi.fn();
  render(<SessionCard planned={session} realised={null} state="skipped" decision={decision({ decision: 'rest' })} onRevert={onRevert} />);
  fireEvent.click(screen.getByText('Rétablir la séance prévue'));
  expect(onRevert).toHaveBeenCalledOnce();
});
