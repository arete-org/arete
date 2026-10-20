import { useGamePreference } from './gamification';

export type CoachName = 'Coach' | 'Chiron';

/** The coach's name on screen: Chiron belongs to the RPG experience, classic mode says Coach. */
export function coachName(rpg: boolean | undefined): CoachName {
  return rpg ? 'Chiron' : 'Coach';
}

/** The name for the athlete's current opt-in; Coach until the preference is known. */
export function useCoachName(): CoachName {
  return coachName(useGamePreference().data?.enabled);
}
