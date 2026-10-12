import { useState } from 'react';

export type CoachDisplay = 'sidebar' | 'floating';
export const COACH_DISPLAY_KEY = 'arete.coach-display.v1';
const STORAGE_ERROR = 'Le mode reste actif pour cette session, mais ce navigateur ne peut pas enregistrer ton choix.';

/** Device-local presentation only: changing it must never replace a running thread. */
export function useCoachDisplay() {
  const [preference, setPreference] = useState((): { mode: CoachDisplay; error: string | null } => {
    try {
      return { mode: localStorage.getItem(COACH_DISPLAY_KEY) === 'floating' ? 'floating' : 'sidebar', error: null };
    } catch {
      return { mode: 'sidebar', error: STORAGE_ERROR };
    }
  });
  const setMode = (mode: CoachDisplay) => {
    let error: string | null = null;
    try { localStorage.setItem(COACH_DISPLAY_KEY, mode); }
    catch { error = STORAGE_ERROR; }
    setPreference({ mode, error });
  };
  return { ...preference, setMode };
}
