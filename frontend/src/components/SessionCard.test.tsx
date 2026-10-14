// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { GarminExport } from '@/lib/documents';
import { watchLine, type WorkoutView } from '@/lib/workouts';
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

const exported = (state: string, error: string | null = null): GarminExport => ({
  session_id: 7, operation_id: 'op', updated_at: '2026-10-09T05:00:00', state, phase: state,
  error, deleted: false, workout_id: 1, schedule_id: 100,
});
const view = (session: Partial<WorkoutView['session']> = {}, state: GarminExport | null = null): WorkoutView => ({
  session: { id: 7, revision: 1, date: '2026-10-09', sport: 'running', description: null, status: 'pending', summary: '45 min Z2', exportable: true, ...session },
  export: state,
});
const send = { run: vi.fn(), pending: false, error: null, result: null };
const card = (push: ReturnType<typeof watchLine>, planned = session) =>
  render(
    <MemoryRouter>
      <SessionCard planned={planned} realised={null} state="pending" push={push} />
    </MemoryRouter>
  );

it('sends to Garmin, then says when it was sent rather than claiming the watch has it', () => {
  const onPush = vi.fn();
  const { unmount } = card(watchLine(view(), null, { ...send, run: onPush }));
  expect(screen.getByText('45 min Z2')).toBeTruthy();
  fireEvent.click(screen.getByText('Envoyer sur la montre'));
  expect(onPush).toHaveBeenCalledOnce();
  unmount();

  // The API sends a UTC instant; the athlete reads their own clock (CEST here).
  vi.stubEnv('TZ', 'Europe/Paris');
  try {
    const sentAt = '2026-10-09T23:01:00+00:00';
    card(watchLine(view({}, exported('scheduled')), sentAt, send), { ...session, garmin_pushed_at: sentAt });
    expect(screen.queryByText('Envoyer sur la montre')).toBeNull();
    expect(screen.getByText('Envoyée à Garmin 01:01')).toBeTruthy();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('shows a session exported by hand as sent, from the export state', () => {
  // Explicit steps exported before ARE-100 carry no push time: the state is enough.
  card(watchLine(view({ prescription: { version: 1, steps: [] } }, exported('transfer_requested')), null, send));
  expect(screen.getByText('Envoyée à Garmin')).toBeTruthy();
  expect(screen.queryByText('Envoyer sur la montre')).toBeNull();
});

it('shows the failure of a send and offers it again', () => {
  card(watchLine(view({}, exported('failed', 'ConnectionError: offline. Aucun renvoi automatique.')), null, send));
  expect(screen.getByText('Envoyer sur la montre')).toBeTruthy();
  expect(screen.getByText(/ConnectionError: offline/)).toBeTruthy();
});

it.each([
  ['uncertain', 'Résultat indéterminé · vérifier Garmin'],
  ['conflict', 'Conflit avec Garmin Connect'],
])('never offers a new send while the export is %s', (state, label) => {
  card(watchLine(view({}, exported(state, 'Réponse perdue')), null, send));
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText('Réponse perdue')).toBeTruthy();
  expect(screen.queryByText('Envoyer sur la montre')).toBeNull();
  // Reconciliation lives with the session in Planning.
  const link = screen.getByText('Vérifier dans le Planning').closest('a');
  expect(link?.getAttribute('href')).toBe('/planning?date=2026-10-09');
});

it('offers to withdraw a skipped session still on Garmin, again after a failure', () => {
  const run = vi.fn();
  const skipped = { status: 'skipped', exportable: false };
  const { unmount } = card(watchLine(view(skipped, exported('scheduled')), null, { ...send, run }), { ...session, status: 'skipped' });
  fireEvent.click(screen.getByText('Retirer de la montre'));
  expect(run).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Envoyée à Garmin/)).toBeNull();
  unmount();
  card(watchLine(view(skipped, exported('failed', 'TimeoutError: lent')), null, send), { ...session, status: 'skipped' });
  expect(screen.getByText('Retirer de la montre')).toBeTruthy();
  expect(screen.getByText('TimeoutError: lent')).toBeTruthy();
  // Withdrawn, or never sent: nothing to do on Garmin.
  const removed = { ...exported('removed'), workout_id: null, schedule_id: null };
  expect(watchLine(view(skipped, removed), null, send)).toBeUndefined();
  expect(watchLine(view(skipped, null), null, send)).toBeUndefined();
});

it('asks for the steps of a described session the server could not read', () => {
  card(watchLine(view({ needs_steps: true, exportable: false }), null, send));
  const link = screen.getByText('Compléter les étapes').closest('a');
  expect(link?.getAttribute('href')).toBe('/planning?date=2026-10-09');
  expect(screen.queryByText('Envoyer sur la montre')).toBeNull();
});

it('shows nothing to send for a session Garmin cannot take', () => {
  expect(watchLine(view({ exportable: false, reason: 'Muscu' }), null, send)).toBeUndefined();
});

it('takes the answer of its own send over an older view', () => {
  const answer = { ...exported('scheduled'), updated_at: '2026-10-09T06:00:00' };
  expect(watchLine(view({}, exported('dirty')), null, { ...send, result: answer })).toEqual({ kind: 'sent', at: null });
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
