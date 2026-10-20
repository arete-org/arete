// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatKg, recordValue, suggestionPrescription } from '@/lib/strengthProgress';
import type { SessionRecord, StrengthSuggestion } from '@/types';
import { RecordsCelebration, SuggestionNote } from './progression';

afterEach(cleanup);

const suggestion = (patch: Partial<StrengthSuggestion> = {}): StrengthSuggestion => ({
  weight_kg: 82.5,
  sets: 3,
  reps: 8,
  rep_range: '8-10',
  rule: 'double_progression',
  reason: 'Toutes les séries à 10 répétitions : +2,5 kg et retour à 8.',
  based_on: '2026-10-08',
  deload: false,
  readiness: null,
  ...patch,
});

const record = (patch: Partial<SessionRecord> = {}): SessionRecord => ({
  exercise_id: 1,
  exercise: 'Hip Thrust',
  kind: 'weight',
  value: 110,
  previous: 100,
  weight_kg: 110,
  reps: 8,
  date: '2026-10-10',
  ...patch,
});

describe('French formatting', () => {
  it('writes loads the French way', () => {
    expect(formatKg(82.5)).toBe('82,5 kg');
    expect(formatKg(null)).toBe('poids du corps');
  });

  it('reads a prescription', () => {
    expect(suggestionPrescription(suggestion())).toBe('3 × 8 @ 82,5 kg (fourchette 8-10)');
    expect(suggestionPrescription(suggestion({ weight_kg: null, rep_range: null }))).toBe(
      '3 × 8 au poids du corps'
    );
  });

  it('says what a record beat', () => {
    expect(recordValue(record())).toBe('110 kg (110 kg × 8), avant 100 kg');
    expect(recordValue(record({ kind: 'reps', value: 9, previous: 8, weight_kg: 100 }))).toBe(
      '9 rép. à 100 kg (avant : 8)'
    );
  });
});

it('shows a deload as such, with its reason', () => {
  render(
    <SuggestionNote
      suggestion={suggestion({ deload: true, rule: 'deload', reason: 'Préparation basse aujourd’hui (40/100).' })}
    />
  );
  expect(screen.getByText(/Allègement/)).toBeTruthy();
  expect(screen.getByText(/Préparation basse/)).toBeTruthy();
});

it('celebrates each record, grouped by exercise', () => {
  render(<RecordsCelebration records={[record(), record({ kind: 'e1rm', value: 139.3, previous: 126.7 })]} />);
  expect(screen.getByText('2 NOUVEAUX RECORDS !')).toBeTruthy();
  expect(screen.getAllByText('Hip Thrust')).toHaveLength(1);
  expect(screen.getByText(/1RM estimé/)).toBeTruthy();
});

it('celebrates nothing without a record', () => {
  const { container } = render(<RecordsCelebration records={[]} />);
  expect(container.innerHTML).toBe('');
});
