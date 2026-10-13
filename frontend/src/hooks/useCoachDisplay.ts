import { useState } from 'react';

export type CoachDisplay = 'sidebar' | 'floating';
export const COACH_DISPLAY_KEY = 'arete.coach-display.v2';
const STORAGE_ERROR = 'Le mode reste actif pour cette session, mais ce navigateur ne peut pas enregistrer ton choix.';

/** Device-local presentation only: changing it must never replace a running thread. */
export function useCoachDisplay() {
  const [preference, setPreference] = useState((): { mode: CoachDisplay; error: string | null } => {
    try {
      // A new key migrates old choices once; subsequent explicit choices survive.
      const saved = localStorage.getItem(COACH_DISPLAY_KEY);
      if (saved !== 'sidebar' && saved !== 'floating') localStorage.setItem(COACH_DISPLAY_KEY, 'floating');
      return { mode: saved === 'sidebar' ? 'sidebar' : 'floating', error: null };
    } catch {
      return { mode: 'floating', error: STORAGE_ERROR };
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
