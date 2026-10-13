import type { QueryClient } from '@tanstack/react-query';
import { documentRequest, type GarminExport, type Prescription } from './documents';

export interface WorkoutSession {
  id: number; revision: number; date: string; sport: string; description: string | null;
  status: string; summary?: string | null; prescription?: Prescription | null;
  derived?: boolean; parsed?: boolean; needs_steps?: boolean; exportable?: boolean; reason?: string | null;
  target_duration_min?: number | null; target_distance_km?: number | null;
}
/** Derived steps of a described tempo or interval session: the type's template, not the workout. */
export const GENERIC_STEPS_LABEL = 'Estimation générique selon le type de séance, pas les étapes décrites';
/** Steps the server read from the description: exportable, and the editor's starting point. */
export const PARSED_STEPS_LABEL = 'Étapes lues dans la description';
export interface WorkoutView { session: WorkoutSession; export: GarminExport | null }
export interface WorkoutUpdate extends WorkoutView {
  type: 'workout_update'; id: string; thread_id: string | null; sequence: number;
}
export interface ExportBatchResult {
  results: GarminExport[]; not_attempted: number[]; blocked?: number; error?: string;
}
export interface WorkoutBatch { workouts: WorkoutView[]; errors: Record<string, string> }
/** The server's bound per read (services/garmin_export.MAX_INSPECT_SESSIONS). */
const MAX_INSPECT_SESSIONS = 50;
export const workoutKey = (id: number) => ['workout', id] as const;
/** Under `['workout']`, so a write's invalidation refreshes a whole list in one request. */
export const workoutsKey = (scope: 'cards' | 'progress', ids: number[]) => ['workout', scope, ...ids] as const;
export const workoutApi = {
  inspect: (id: number) => documentRequest<WorkoutView>(`/garmin/planned/${id}/workout`),
  inspectMany: (ids: number[]) => documentRequest<WorkoutBatch>(`/garmin/workouts?${ids.map(id => `ids=${id}`).join('&')}`),
  export: (sessions: WorkoutSession[], deviceId: number | null) => documentRequest<ExportBatchResult>(
    '/garmin/exports/batch', { method: 'POST', body: JSON.stringify({ session_ids: sessions.map(s => s.id), revisions: sessions.map(s => s.revision), device_id: deviceId }) }, 150_000),
};
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }
export function isWorkoutUpdate(value: unknown): value is WorkoutUpdate {
  if (!record(value) || value.type !== 'workout_update' || typeof value.id !== 'string' ||
      !(value.thread_id === null || typeof value.thread_id === 'string') ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || !record(value.session)) return false;
  const s = value.session;
  return Number.isSafeInteger(s.id) && Number(s.id) > 0 && Number.isSafeInteger(s.revision) && Number(s.revision) > 0 &&
    typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && typeof s.sport === 'string' &&
    typeof s.status === 'string' && (s.description === null || typeof s.description === 'string') &&
    (s.summary === undefined || s.summary === null || (typeof s.summary === 'string' && s.summary.length <= 32_000)) &&
    (value.export === null || (record(value.export) && value.export.session_id === s.id && typeof value.export.state === 'string' &&
      typeof value.export.operation_id === 'string' && typeof value.export.updated_at === 'string'));
}
export function newerExport(current: GarminExport | null, incoming: GarminExport | null): GarminExport | null {
  if (!incoming) return current;
  if (current?.updated_at && incoming.updated_at && current.updated_at > incoming.updated_at) return current;
  return incoming;
}
/** Server revisions and durable update times protect against stale reads and parallel tools. */
export function mergeWorkout(previous: WorkoutView | undefined, next: WorkoutView): WorkoutView {
  if (!previous) return next;
  if (previous.session.revision > next.session.revision) return previous;
  const session = previous.session.revision === next.session.revision ? { ...previous.session, ...next.session } : next.session;
  return { session, export: newerExport(previous.export, next.export) };
}
export function cacheWorkout(queryClient: QueryClient, view: WorkoutView): void {
  queryClient.setQueryData<WorkoutView>(workoutKey(view.session.id), previous => mergeWorkout(previous, view));
}
/** Reads several cards at once and seeds each card's entry; per-session errors stay per session. */
export async function readWorkouts(queryClient: QueryClient, ids: number[]): Promise<WorkoutBatch> {
  const result: WorkoutBatch = { workouts: [], errors: {} };
  for (let offset = 0; offset < ids.length; offset += MAX_INSPECT_SESSIONS) {
    const batch = await workoutApi.inspectMany(ids.slice(offset, offset + MAX_INSPECT_SESSIONS));
    batch.workouts.forEach(view => cacheWorkout(queryClient, view));
    result.workouts.push(...batch.workouts);
    Object.assign(result.errors, batch.errors);
  }
  return result;
}
export const exportLabels: Record<string, string> = {
  scheduled: 'Programmée dans Garmin Connect', transfer_requested: 'Transfert demandé · synchronise la montre',
  working: 'Envoi vers Garmin', dirty: 'À resynchroniser', pending_removal: 'Retrait Garmin à effectuer',
  uncertain: 'Résultat indéterminé · vérifier Garmin', conflict: 'Conflit avec Garmin Connect',
  failed: 'Envoi non confirmé', ready: 'Vérifiée · prête à envoyer', removed: 'Retirée de Garmin Connect',
};
export function exportLabel(state: GarminExport | null): string {
  if (!state) return 'Pas encore envoyée';
  if (state.state === 'working' && ['created', 'updated', 'scheduled', 'unscheduled'].includes(state.phase ?? '')) return 'Vérification dans Garmin';
  return exportLabels[state.state] ?? 'État à vérifier';
}
/** Where today's session stands with Garmin (the export view, ARE-100). */
export type SessionPush =
  | {
      kind: 'send';
      /** Steps the watch will get, e.g. "10 min · 4 × (3 min / 2 min) · 10 min". */
      text: string | null;
      onPush: () => void;
      pending: boolean;
      error: string | null;
    }
  /** `at` is the UTC push instant; older explicit exports have none. */
  | { kind: 'sent'; at: string | null }
  /** In flight, uncertain or in conflict: no new send until it is settled. */
  | { kind: 'unsettled'; label: string; error: string | null }
  /** A described session whose steps the server could not read. */
  | { kind: 'steps'; href: string };

/**
 * The Garmin line for a session from its export view. `send.result` answers
 * the athlete's own send and is newer than the view until it refreshes.
 */
export function watchLine(
  view: WorkoutView,
  sentAt: string | null,
  send: { onPush: () => void; pending: boolean; error: string | null; result: GarminExport | null }
): SessionPush | undefined {
  const current = newerExport(view.export, send.result);
  const state = current?.state;
  if (state === 'scheduled' || state === 'transfer_requested') return { kind: 'sent', at: sentAt };
  if (current && (state === 'working' || state === 'uncertain' || state === 'conflict'))
    return { kind: 'unsettled', label: exportLabel(current), error: state === 'working' ? null : current.error };
  if (view.session.needs_steps) return { kind: 'steps', href: `/planning?date=${view.session.date}` };
  if (!view.session.exportable) return undefined;
  return {
    kind: 'send',
    text: view.session.summary ?? null,
    onPush: send.onPush,
    pending: send.pending,
    error: send.error ?? (state === 'failed' ? current?.error ?? exportLabel(current ?? null) : null),
  };
}
