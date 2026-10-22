import { describe, expect, it } from 'vitest';
import type { ActivityDetail } from '@/types';
import { summaryKind, summaryNumbers } from './summaryNumbers';

const session: ActivityDetail['session'] = {
  id: 1,
  date: '2026-10-20',
  start_time: null,
  sport: 'running',
  session_type: null,
  name: null,
  duration_sec: 3000,
  moving_time_sec: 2940,
  distance_m: 10200,
  calories: 640,
  avg_hr: 148,
  max_hr: 165,
  avg_pace_sec_km: 290,
  avg_speed_mps: 3.45,
  max_speed_mps: 4.1,
  ascent_m: 40,
  descent_m: 38,
  avg_cadence: 176,
  max_cadence: 190,
  avg_watts: null,
  rpe: 6,
  notes: null,
  source: 'garmin_connect',
  device_name: null,
  planned_session_id: null,
  adherence_score: null,
};

function detail(overrides: Partial<ActivityDetail> = {}, fields: Partial<ActivityDetail['session']> = {}): ActivityDetail {
  return {
    session: { ...session, ...fields },
    zones: null,
    laps: [],
    splits: [],
    intervals: null,
    metrics: null,
    streams: null,
    route: null,
    feedback: null,
    terrain: null,
    weather: null,
    summary: { rule_feedback: null, strength: null, plan: null, next_day: null },
    ...overrides,
  };
}

const shown = (d: ActivityDetail) => summaryNumbers(d).map((n) => [n.label, n.value, n.detail]);

describe('summaryNumbers', () => {
  it('leads a run with distance, pace and heart rate', () => {
    expect(summaryKind(detail())).toBe('run');
    expect(shown(detail())).toEqual([
      ['Distance', '10,20 km', undefined],
      ['Allure moyenne', '4:50 /km', undefined],
      ['FC moyenne', '148 bpm', undefined],
    ]);
  });

  it('adds the grade-adjusted pace only when the slope weighed', () => {
    const hilly = detail({ terrain: { grade_factor: 1.12, gap_sec_km: 259, vam: {}, descent: [] } });
    expect(summaryNumbers(hilly)[1]).toMatchObject({ value: '4:50 /km', detail: 'GAP 4:19 /km', term: 'gap' });
    const flat = detail({ terrain: { grade_factor: 1.01, gap_sec_km: 287, vam: {}, descent: [] } });
    expect(summaryNumbers(flat)[1].detail).toBeUndefined();
  });

  it('falls back on the felt effort when no heart rate was recorded', () => {
    expect(summaryNumbers(detail({}, { avg_hr: null }))[2]).toMatchObject({ label: 'Effort ressenti', value: '6/10' });
  });

  it('leads an interval run with its reps and their own pace', () => {
    const intervals = detail({
      intervals: {
        count: 5,
        work_avg_sec: 240,
        rest_avg_sec: 90,
        warmup_sec: 600,
        cooldown_sec: 300,
        pace_cv_pct: 1.2,
        hr_progression_pct: 3.4,
        work: [
          { n: 1, lap: 2, duration_sec: 240, distance_m: 1000, pace_sec_km: 240, avg_hr: 170 },
          { n: 2, lap: 4, duration_sec: 250, distance_m: 1000, pace_sec_km: 250, avg_hr: 172 },
        ],
      },
    });
    expect(summaryKind(intervals)).toBe('intervals');
    expect(shown(intervals)).toEqual([
      ['Fractionné', '5 × 4 min', 'récup 1 min 30 s'],
      ['Allure des répétitions', '4:05 /km', undefined],
      ['FC moyenne', '148 bpm', undefined],
    ]);
  });

  it('leads a ride with its power when measured, else its speed', () => {
    const ride = detail({}, { sport: 'cycling', avg_pace_sec_km: null, distance_m: 42000, avg_speed_mps: 8.2 });
    expect(summaryKind(ride)).toBe('ride');
    expect(shown(ride)).toEqual([
      ['Distance', '42,00 km', undefined],
      ['Vitesse moyenne', '29,5 km/h', undefined],
      ['FC moyenne', '148 bpm', undefined],
    ]);
    const powered = detail({}, { sport: 'cycling', avg_watts: 212 });
    expect(summaryNumbers(powered)[1]).toMatchObject({ label: 'Puissance moyenne', value: '212 W' });
  });

  it('leads a swim with metres and its pace per 100 m', () => {
    const swim = detail({}, { sport: 'lap_swimming', distance_m: 1500, moving_time_sec: 1800, avg_pace_sec_km: null });
    expect(shown(swim)).toEqual([
      ['Distance', '1 500 m', undefined],
      ['Allure moyenne', '2:00 /100 m', undefined],
      ['Durée', '30min', undefined],
    ]);
  });

  it('leads a hike with distance, climb and time', () => {
    const hike = detail({}, { sport: 'hiking', ascent_m: 820, moving_time_sec: 12600 });
    expect(shown(hike).map(([label]) => label)).toEqual(['Distance', 'Dénivelé +', 'Durée']);
  });

  it('leads a strength session with tonnage, sets and the top 1RM change against its last session', () => {
    const strength = detail(
      {
        summary: {
          rule_feedback: null,
          plan: null,
          next_day: null,
          strength: {
            tonnage_kg: 4250,
            sets: 18,
            top_e1rm: { exercise: 'Squat', e1rm_kg: 120, previous_kg: 117.5, previous_date: '2026-10-13' },
          },
        },
      },
      { sport: 'strength', distance_m: null, avg_pace_sec_km: null },
    );
    expect(summaryKind(strength)).toBe('strength');
    expect(shown(strength)).toEqual([
      ['Tonnage', '4 250 kg', 'séries de travail'],
      ['Séries', '18 séries', 'hors échauffement'],
      ['1RM estimé · Squat', '+2,5 kg', '120 kg · vs 13 oct.'],
    ]);
  });

  it('says a first 1RM is a first measure, not a change', () => {
    const first = detail(
      {
        summary: {
          rule_feedback: null,
          plan: null,
          next_day: null,
          strength: { tonnage_kg: 500, sets: 1, top_e1rm: { exercise: 'Squat', e1rm_kg: 100, previous_kg: null, previous_date: null } },
        },
      },
      { sport: 'strength' },
    );
    expect(summaryNumbers(first)[1].value).toBe('1 série');
    expect(summaryNumbers(first)[2]).toMatchObject({ value: '100 kg', detail: 'première mesure' });
  });

  it('keeps an unchanged 1RM as its value and drops a bodyweight tonnage', () => {
    const steady = detail(
      {
        summary: {
          rule_feedback: null,
          plan: null,
          next_day: null,
          strength: { tonnage_kg: 0, sets: 4, top_e1rm: { exercise: 'Squat', e1rm_kg: 100, previous_kg: 100, previous_date: '2026-10-13' } },
        },
      },
      { sport: 'strength', distance_m: null },
    );
    expect(shown(steady)).toEqual([
      ['Séries', '4 séries', 'hors échauffement'],
      ['1RM estimé · Squat', '100 kg', 'stable vs 13 oct.'],
      ['Durée', '49min', undefined],
    ]);
  });

  it('gives a strength activity without logged loads its time, heart and effort', () => {
    const watchOnly = detail({}, { sport: 'strength_training', distance_m: null, avg_pace_sec_km: null });
    expect(shown(watchOnly).map(([label]) => label)).toEqual(['Durée', 'FC moyenne', 'Effort ressenti']);
  });

  it('never shows a dash: a session with little data shows fewer numbers', () => {
    const bare = detail({}, {
      sport: 'yoga', moving_time_sec: null, duration_sec: 1800, distance_m: null, avg_hr: null, rpe: null, calories: null,
    });
    expect(shown(bare)).toEqual([['Durée', '30min', undefined]]);
  });
});
