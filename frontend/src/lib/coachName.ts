import { useGamePreference } from './gamification';

/**
 * How the coach is named in a sentence. Chiron, the RPG character, is a proper
 * name; in classic mode « le coach » is a common noun, so French needs its own
 * article and preposition in each position (« au coach », « du coach »).
 */
export interface CoachWords {
  /** Alone, as a header or label: « Coach » / « Chiron ». */
  name: 'Coach' | 'Chiron';
  /** Within a sentence, after « avec », « par », « que »…: « le coach » / « Chiron ». */
  the: string;
  /** Opening a sentence: « Le coach » / « Chiron ». */
  The: string;
  /** After « à »: « au coach » / « à Chiron ». */
  to: string;
  /** After « de »: « du coach » / « de Chiron ». */
  of: string;
  /** The dashboard panel's title. */
  today: string;
  /** The briefing's call to discuss it. */
  discuss: string;
}

const CLASSIC: CoachWords = {
  name: 'Coach', the: 'le coach', The: 'Le coach', to: 'au coach', of: 'du coach',
  today: 'Le coach aujourd’hui', discuss: 'En parler au coach',
};
const RPG: CoachWords = {
  name: 'Chiron', the: 'Chiron', The: 'Chiron', to: 'à Chiron', of: 'de Chiron',
  today: 'Avec Chiron aujourd’hui', discuss: 'En parler avec Chiron',
};

/** Chiron belongs to the RPG opt-in; classic mode, and an unknown preference, say « le coach ». */
export function coachWords(rpg: boolean | undefined): CoachWords {
  return rpg ? RPG : CLASSIC;
}

/** The words for the athlete's current opt-in. */
export function useCoachWords(): CoachWords {
  return coachWords(useGamePreference().data?.enabled);
}
