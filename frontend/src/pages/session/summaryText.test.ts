import { describe, expect, it } from 'vitest';
import { coachWords } from '@/lib/coachName';
import type { PlannedBrief } from '@/types';
import { leadSentence, nextDayLine } from './summaryText';

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
