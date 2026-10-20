import { expect, it } from 'vitest';
import { coachWords } from './coachName';

it('names the coach as a common noun in classic mode and while the opt-in is unknown', () => {
  for (const words of [coachWords(false), coachWords(undefined)]) {
    expect(`Demander ${words.to}`).toBe('Demander au coach');
    expect(`Le regard ${words.of}`).toBe('Le regard du coach');
    expect(`${words.The} relit ta récupération`).toBe('Le coach relit ta récupération');
    expect(`Ce que ${words.the} sait de moi`).toBe('Ce que le coach sait de moi');
    expect(words.today).toBe('Le coach aujourd’hui');
    expect(words.discuss).toBe('En parler au coach');
    expect(words.name).toBe('Coach');
    expect(Object.values(words).join(' ')).not.toMatch(/Chiron|à Coach|avec Coach|de Coach/);
  }
});

it('keeps Chiron and its phrasing in the RPG experience', () => {
  const words = coachWords(true);
  expect(`Demander ${words.to}`).toBe('Demander à Chiron');
  expect(`Le regard ${words.of}`).toBe('Le regard de Chiron');
  expect(`${words.The} relit ta récupération`).toBe('Chiron relit ta récupération');
  expect(words.today).toBe('Avec Chiron aujourd’hui');
  expect(words.discuss).toBe('En parler avec Chiron');
  expect(words.name).toBe('Chiron');
});
