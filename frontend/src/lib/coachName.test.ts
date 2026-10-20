import { expect, it } from 'vitest';
import { coachName } from './coachName';

it('says Coach in classic mode, while the opt-in is unknown, and Chiron in the RPG', () => {
  expect(coachName(false)).toBe('Coach');
  expect(coachName(undefined)).toBe('Coach');
  expect(coachName(true)).toBe('Chiron');
});
