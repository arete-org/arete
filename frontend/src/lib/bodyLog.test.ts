import { expect, it } from 'vitest';
import { formatKg, painTone, parseWeight, weightSentence, type WeightEntry } from './bodyLog';

const entry = (date: string, weight_kg: number): WeightEntry => ({
  date, weight_kg, source: 'manual', created_at: `${date}T07:00:00Z`, updated_at: `${date}T07:00:00Z`,
});

it('reads a weight typed with a comma or a dot, within the server’s bounds', () => {
  expect(parseWeight('71,46')).toBe(71.5);
  expect(parseWeight(' 70.2 ')).toBe(70.2);
  expect(parseWeight('')).toBeNull();
  expect(parseWeight('soixante')).toBeNull();
  expect(parseWeight('12')).toBeNull();
  expect(parseWeight('251')).toBeNull();
});

it('writes kilograms the French way, with a true minus sign', () => {
  expect(formatKg(71.4)).toBe('71,4 kg');
  expect(formatKg(-0.8, true)).toBe('−0,8 kg');
  expect(formatKg(1.2, true)).toBe('+1,2 kg');
});

it('says the latest weight and, when there is one, its change', () => {
  expect(weightSentence({ latest: null, average_7d: null, change_kg: null, change_since: null })).toBe(
    'Aucun poids noté sur la période.',
  );
  const latest = entry('2026-10-22', 71.4);
  expect(weightSentence({ latest, average_7d: 71.4, change_kg: null, change_since: null })).toBe('71,4 kg le 22 oct.');
  expect(weightSentence({ latest, average_7d: 71.4, change_kg: -0.8, change_since: '2026-09-25' })).toBe(
    '71,4 kg le 22 oct. (−0,8 kg depuis le 25 sept.)',
  );
  expect(weightSentence({ latest, average_7d: 71.4, change_kg: 0, change_since: '2026-09-25' })).toContain('(stable depuis');
});

it('tones a pain by its intensity: 4 and 7 open the warning and danger bands', () => {
  expect([0, 3, 4, 6, 7, 10].map(painTone)).toEqual(['calm', 'calm', 'warning', 'warning', 'danger', 'danger']);
});
