import { describe, expect, it } from 'vitest';
import { starters } from './coachPrompts';

describe('coach prompts', () => {
  it('opens on questions about the page', () => {
    expect(starters('planning')[0]).toContain('semaine');
  });

  it('opens the Santé page on its pain, weight and report', () => {
    expect(starters('health')).toEqual([
      'Ma douleur doit-elle changer ma semaine ?',
      'Comment évolue mon poids ?',
      'Que dire à mon kiné de ces 8 semaines ?',
    ]);
  });

  it('falls back to general questions on an unknown page', () => {
    expect(starters('admin')).toContain('Que peux-tu faire pour moi ?');
  });

});
