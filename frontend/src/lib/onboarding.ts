import { fetchAPI } from './api';

export const GOALS = { restart: ['Reprendre', 'Retrouver le plaisir, à ton rythme.'], progress: ['Progresser', 'Construire sur tes habitudes.'], race: ['Préparer une course', 'Donner un cap à tes efforts.'], consistency: ['Rester régulier', 'Faire une place au sport.'] } as const;
export const SPORTS = { running: 'Course à pied', strength: 'Renforcement', cycling: 'Vélo', other: 'Autre sport' } as const;
export const DAYS = { monday: 'Lundi', tuesday: 'Mardi', wednesday: 'Mercredi', thursday: 'Jeudi', friday: 'Vendredi', saturday: 'Samedi', sunday: 'Dimanche' } as const;
export interface Answers {
  display_name: string | null;
  goal: keyof typeof GOALS | null;
  description: string | null;
  race_name: string | null;
  race_date: string | null;
  sports: (keyof typeof SPORTS)[];
  weekly_training_goal: number | null;
  rest_day_preference: (keyof typeof DAYS)[] | null;
  constraints: string | null;
  timezone: string | null;
}
export interface OnboardingDraft { version: 1; step: number; deferred: boolean; command_id: string; answers: Answers }
export interface OnboardingProgress { revision: number; status: 'completed' | 'not_started' }
export interface OnboardingContext { revision: number; content: string; forgotten: boolean }
export const onboardingKey = ['onboarding'] as const;
export const onboardingApi = {
  get: () => fetchAPI<OnboardingProgress>('/onboarding'),
  context: () => fetchAPI<OnboardingContext>('/onboarding/context'),
  confirm: (draft: OnboardingDraft, revision: number) => fetchAPI<OnboardingProgress>('/onboarding', { method: 'POST', body: JSON.stringify({ command_id: draft.command_id, expected_revision: revision, answers: draft.answers }), signal: AbortSignal.timeout(20_000) }),
};
function key(athleteId: number) {
  if (!Number.isSafeInteger(athleteId) || athleteId < 1) throw new Error('Athlète absent.');
  return `arete.onboarding.v1.athlete.${athleteId}`;
}
export function newDraft(): OnboardingDraft {
  return { version: 1, step: 1, deferred: false, command_id: crypto.randomUUID(), answers: { display_name: null, goal: null, description: null, race_name: null, race_date: null, sports: [], weekly_training_goal: null, rest_day_preference: null, constraints: null, timezone: null } };
}
export function readDraft(athleteId: number): OnboardingDraft {
  const raw = localStorage.getItem(key(athleteId));
  if (!raw) return newDraft();
  if (raw.length > 8_000) throw new Error('Brouillon trop volumineux.');
  const draft = JSON.parse(raw) as OnboardingDraft;
  const a = draft?.answers;
  if (draft.version !== 1 || !Number.isInteger(draft.step) || draft.step < 1 || draft.step > 4 || typeof draft.deferred !== 'boolean' || typeof draft.command_id !== 'string' || !a || !Array.isArray(a.sports) || a.sports.length > 4 || a.sports.some(s => !(s in SPORTS)) || (a.goal !== null && !(a.goal in GOALS)) || ![a.display_name, a.description, a.race_name, a.race_date, a.constraints, a.timezone].every(v => v === null || typeof v === 'string') || (a.weekly_training_goal !== null && (!Number.isInteger(a.weekly_training_goal) || a.weekly_training_goal < 1 || a.weekly_training_goal > 14)) || (a.rest_day_preference !== null && (!Array.isArray(a.rest_day_preference) || a.rest_day_preference.length > 7 || a.rest_day_preference.some(d => !(d in DAYS))))) throw new Error('Brouillon illisible. Sa copie enregistrée est conservée.');
  return draft;
}
export function writeDraft(athleteId: number, draft: OnboardingDraft) {
  const raw = JSON.stringify(draft);
  if (raw.length > 8_000) throw new Error('Brouillon trop volumineux.');
  localStorage.setItem(key(athleteId), raw);
}
export function clearDraft(athleteId: number) { localStorage.removeItem(key(athleteId)); }
