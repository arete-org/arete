import { describe, expect, it } from 'vitest';
import { coachWords } from '@/lib/coachName';
import type { PlannedBrief } from '@/types';
import { leadSentence, nextDayLine, planLine } from './summaryText';

const planned: PlannedBrief = {
  id: 7, date: '2026-10-21', sport: 'running', session_type: 'tempo', description: null,
  target_duration_min: 50, target_distance_km: null, target_hr_zone: 'Z4', status: 'pending',
};

describe('leadSentence', () => {
  it('keeps the first sentence and the rest apart', () => {
    expect(leadSentence('Sortie régulière, cardio stable du début à la fin. Bravo.')).toEqual([
      'Sortie régulière, cardio stable du début à la fin.',
      'Bravo.',
    ]);
  });

  it('joins a too short opening to the next sentence, and a single sentence stays whole', () => {
    expect(leadSentence('Bravo ! Le fractionné est resté régulier jusqu’au bout. Récupère demain.')).toEqual([
      'Bravo ! Le fractionné est resté régulier jusqu’au bout.',
      'Récupère demain.',
    ]);
    expect(leadSentence('Allure 4:50 /km tenue.')).toEqual(['Allure 4:50 /km tenue.', '']);
  });
});

describe('nextDayLine', () => {
  const day = { date: '2026-10-21', relative: 'today' as const, planned: [planned], next: null };

  it('names the coach by the athlete’s mode and says an applied decision is applied', () => {
    const proposal = { planned_session_id: 7, decision: 'ease', reason: 'Préparation basse.', state: 'pending' };
    expect(nextDayLine({ ...day, proposals: [proposal] }, coachWords(false)).text).toBe('Seuil · 50 min · Z4, le coach propose : allégée.');
    expect(nextDayLine({ ...day, proposals: [proposal] }, coachWords(true)).text).toBe('Seuil · 50 min · Z4, Chiron propose : allégée.');
    const applied = nextDayLine({ ...day, proposals: [{ ...proposal, state: 'applied' }] }, coachWords(false));
    expect(applied).toEqual({ label: 'Aujourd’hui', text: 'Seuil · 50 min · Z4, allégée (déjà appliquée).', reasons: ['Préparation basse.'] });
  });

  it('says when nothing is planned, and which session comes next', () => {
    const empty = { date: '2026-10-22', relative: 'tomorrow' as const, planned: [], proposals: [] };
    expect(nextDayLine({ ...empty, next: null }, coachWords(false))).toEqual({ label: 'Demain', text: 'rien de prévu au planning.', reasons: [] });
    expect(nextDayLine({ ...empty, next: { ...planned, date: '2026-10-24' } }, coachWords(false)).text).toBe(
      'rien de prévu. Prochaine séance samedi 24 oct. : Seuil · 50 min · Z4.',
    );
  });
});

describe('planLine', () => {
  const run = { duration_sec: 48 * 60 + 20, avg_hr: 151.6 };
  const footing: PlannedBrief = { ...planned, session_type: 'endurance', description: 'Footing souple', target_duration_min: 45, target_hr_zone: 'Z2' };

  it('words each verdict with the duration and the heart rate against their targets', () => {
    const plan = { planned: footing, verdict: 'on_plan' as const, target_hr_bpm: 154 };
    expect(planLine(plan, run)).toEqual({
      label: 'Face au plan',
      verdict: 'conforme',
      text: '48 min au total pour 45 min prévues, FC 152 bpm pour une Z2 autour de 154 bpm.',
      title: 'Footing souple',
      href: '/planning?date=2026-10-21&session=7',
    });
    const words = (['shorter', 'longer', 'harder', 'easier'] as const).map((verdict) => planLine({ ...plan, verdict }, run).verdict);
    expect(words).toEqual(['plus court', 'plus long', 'plus intense', 'plus facile']);
  });

  it('leaves out what was not measured', () => {
    const noZone = { planned: { ...footing, target_hr_zone: null }, verdict: 'shorter' as const, target_hr_bpm: null };
    expect(planLine(noZone, { ...run, duration_sec: 35 * 60 }).text).toBe('35 min au total pour 45 min prévues.');
    const noDuration = { planned: { ...footing, target_duration_min: null }, verdict: 'harder' as const, target_hr_bpm: 154 };
    expect(planLine(noDuration, { ...run, avg_hr: 178 }).text).toBe('FC 178 bpm pour une Z2 autour de 154 bpm.');
  });

  it('names the planned session when nothing could be compared', () => {
    const distance = { ...footing, target_duration_min: null, target_distance_km: 10 };
    expect(planLine({ planned: distance, verdict: null, target_hr_bpm: 154 }, { ...run, avg_hr: null })).toMatchObject({
      label: 'Séance prévue',
      verdict: null,
      text: 'Footing souple · 10 km · Z2.',
    });
  });
});
