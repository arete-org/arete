import { describe, expect, it } from 'vitest';
import { withStrengthLogs } from '@/components/SessionCard';
import type { ActualSession, PlannedSession, StrengthSession } from '@/types';
import { linkDay, weekStats } from './sessionMatch';

const planned = (over: Partial<PlannedSession> = {}): PlannedSession => ({
  id: 1,
  date: '2026-10-09',
  sport: 'running',
  session_type: 'endurance',
  target_duration_min: 45,
  target_distance_km: null,
  target_hr_zone: 'Z2',
  target_intensity: 'easy',
  description: null,
  source: 'manual',
  status: 'pending',
  garmin_workout_id: null,
  garmin_pushed_at: null,
  ...over,
});

const run = (over: Partial<ActualSession> = {}): ActualSession =>
  ({
    id: 10,
    planned_session_id: null,
    date: '2026-10-09',
    sport: 'running',
    duration_sec: 2700,
    ...over,
  }) as ActualSession;

describe('a session the morning adaptation modified', () => {
  const modified = planned({ status: 'modified', session_type: 'recovery' });

  it('is still to do today until something is done', () => {
    const link = linkDay('2026-10-09', [modified], [], '2026-10-09');
    expect(link.planned[0].state).toBe('pending');
  });

  it('is missed once its day has passed without a session', () => {
    const link = linkDay('2026-10-09', [modified], [], '2026-10-10');
    expect(link.planned[0].state).toBe('missed');
  });

  it('is done by a realised session of the same sport', () => {
    const link = linkDay('2026-10-09', [modified], [run()], '2026-10-09');
    expect(link.planned[0]).toMatchObject({ state: 'done', realised: { id: 10 } });
    expect(link.offPlan).toEqual([]);
  });

  it('counts as due, not as done, in the week stats', () => {
    const stats = weekStats(['2026-10-09'], [modified], [], '2026-10-09');
    expect(stats).toMatchObject({ due: 1, done: 0, missed: 0 });
  });
});

describe('a Garmin strength activity and its Muscu log', () => {
  const muscu = planned({ id: 2, sport: 'strength', session_type: 'strength', target_hr_zone: null });
  const garmin = run({ id: 30, sport: 'strength', name: 'Musculation', duration_sec: 3600 });
  const log = (over: Partial<StrengthSession> = {}): StrengthSession => ({
    id: 5,
    date: '2026-10-09',
    name: null,
    program: null,
    duration_min: 60,
    overall_rpe: 7,
    fatigue_level: null,
    sleep_quality: null,
    notes: null,
    total_volume: 4000,
    total_sets: 12,
    exercise_names: ['Squat', 'Développé couché'],
    garmin_activity_id: 30,
    ...over,
  });

  it('are one session that fulfils the planned Muscu, with the log’s exercises', () => {
    const actual = withStrengthLogs([garmin], [log()]);
    expect(actual).toHaveLength(1);
    const link = linkDay('2026-10-09', [muscu], actual, '2026-10-09');
    expect(link.planned[0]).toMatchObject({
      state: 'done',
      realised: { id: 30, exercises: ['Squat', 'Développé couché'] },
    });
    expect(link.offPlan).toEqual([]);
    expect(weekStats(['2026-10-09'], [muscu], actual, '2026-10-09')).toMatchObject({ done: 1, offPlan: 0 });
  });

  it('stay two entries while unlinked', () => {
    const actual = withStrengthLogs([garmin], [log({ garmin_activity_id: null })]);
    expect(actual.map((a) => a.id)).toEqual([30, -5]);
    expect(linkDay('2026-10-09', [muscu], actual, '2026-10-09').offPlan).toHaveLength(1);
  });

  it('keep the log when its linked activity is not in the list', () => {
    expect(withStrengthLogs([], [log()]).map((a) => a.id)).toEqual([-5]);
  });
});
