import { fetchAPI } from './api';
import type { PlanDecision } from '@/types';

/** What the athlete asks the coach about: the server reads it by id, the browser sends nothing else. */
export type CoachReference = { kind: 'proposal' | 'followup' | 'briefing' | 'review' | 'session'; id: number } | { kind: 'automation_run'; id: string; mode?: 'review' | 'discussion' };
const MAX_COACH_REFERENCE_ID = 9_999_999_999; // Matches the server reference parser.
export function isCoachReference(value: unknown): value is CoachReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as CoachReference;
  if (ref.kind === 'automation_run') return typeof ref.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref.id) && (ref.mode === undefined || ref.mode === 'review' || ref.mode === 'discussion');
  return ['proposal', 'followup', 'briefing', 'review', 'session'].includes(ref.kind) && Number.isSafeInteger(ref.id) && ref.id > 0 && ref.id <= MAX_COACH_REFERENCE_ID;
}
export interface Proposal extends PlanDecision {
  state: 'pending' | 'discussion' | 'applied' | 'dismissed' | 'stale';
  revision: number;
  session_revision: number;
  readiness_measured_on: string | null;
}
export interface Followup {
  id: number;
  session_id: number;
  decision_id: number | null;
  question: string;
  requested_on: string;
  expires_at: string;
  state: 'pending' | 'answered' | 'skipped';
  revision: number;
  rpe: number | null;
  notes: string | null;
}
export interface SeenRevision { id: number; revision: number }
/**
 * A day's proposals are answered together: `record` leads, `group` lists the
 * shown ones and `members` every open one, which the response must name.
 */
export type CoachItem = { kind: 'proposal'; record: Proposal; group: Proposal[]; members: SeenRevision[] } | { kind: 'followup'; record: Followup };
export interface CoachToday {
  date: string;
  items: CoachItem[];
  remaining: number;
  briefing: { text: string; created_at: string | null } | null;
}
export const coachTodayKey = ['coachToday'] as const;
export const coachApi = {
  today: () => fetchAPI<CoachToday>('/coach/today'),
  prepare: () => fetchAPI<CoachToday>('/coach/prepare', { method: 'POST' }),
  /** `garmin`: what Garmin did for this session after an applied answer (absent from an older server). */
  proposal: (id: number, revision: number, action: 'apply' | 'keep' | 'snooze', group: SeenRevision[] = []) =>
    fetchAPI<Proposal & { garmin?: import('@/types').RenegotiationGarmin }>(`/coach/proposals/${id}/response`, { method: 'POST', body: JSON.stringify({ revision, action, group }) }),
  followup: (id: number) => fetchAPI<Followup>(`/coach/followups/${id}`),
  respond: (id: number, revision: number, action: 'answer' | 'skip' | 'snooze', rpe?: number, notes?: string) =>
    fetchAPI<Followup>(`/coach/followups/${id}/response`, { method: 'POST', body: JSON.stringify({ revision, action, rpe, notes }) }),
};
export function discussWithCoach(reference: CoachReference) {
  window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: reference }));
}
