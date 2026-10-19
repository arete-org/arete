import { markWorkout, measureWorkout } from '@/lib/workoutPerformance';
import { useIsMutating, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { exportApi, type Prescription } from '@/lib/documents';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { cacheWorkout, exportLabel, workoutApi, workoutKey, type WorkoutSession, type WorkoutView } from '@/lib/workouts';
import { readableError } from '@/lib/utils';

type Action = { kind: 'export'; sessions: WorkoutSession[]; deviceId: number | null }
  | { kind: 'verify' | 'remove'; session: WorkoutSession }
  | { kind: 'edit'; session: WorkoutSession; date: string; description: string; prescription: Prescription };
const key = ['workout-action'];
const MAX_SELECTED = 50;
export function useWorkoutActions(onResult?: (text: string) => void) {
  const queryClient = useQueryClient();
  const busy = useIsMutating({ mutationKey: key }) > 0;
  const pending = useMutationState({ filters: { mutationKey: key, exact: true, status: 'pending' }, select: m => m.state.variables as Action });
  const pendingIds = new Set(pending.flatMap(a => a.kind === 'export' ? a.sessions.map(s => s.id) : [a.session.id]));
  const pendingLabels = new Map(pending.flatMap<readonly [number, string]>(a => a.kind === 'export'
    ? a.sessions.map(s => [s.id, 'Envoi en cours…'] as const)
    : [[a.session.id, a.kind === 'verify' ? 'Vérification dans Garmin…' : a.kind === 'edit' ? 'Enregistrement…' : 'Retrait en cours…'] as const]));
  const mutation = useMutation({
    mutationKey: key,
    retry: false,
    mutationFn: async (action: Action) => {
      markWorkout('workout:action-start');
      if (action.kind === 'export') {
        if (!action.sessions.length || action.sessions.length > MAX_SELECTED) throw new Error('Sélectionne entre 1 et 50 séances.');
        let done = 0;
        for (let offset = 0; offset < action.sessions.length; offset += 5) {
          let batch;
          try { batch = await workoutApi.export(action.sessions.slice(offset, offset + 5), action.deviceId); }
          catch (error) { throw new Error(`${done}/${action.sessions.length} programmation(s) confirmée(s). Le lot courant est à vérifier avant tout renvoi : ${readableError(error)}`); }
          for (const result of batch.results) {
            const session = action.sessions.find(s => s.id === result.session_id)!;
            cacheWorkout(queryClient, { session, export: result });
            if (['scheduled', 'transfer_requested'].includes(result.state)) done++;
          }
          if (batch.error) throw new Error(`${done}/${action.sessions.length} séance(s) programmée(s). ${batch.error} Les autres n’ont pas été renvoyées.`);
        }
        return `${done} séance(s) programmée(s) dans Garmin Connect${action.deviceId ? ' ; transfert montre demandé' : ''}.`;
      }
      if (action.kind === 'edit') await exportApi.update(action.session.id, action.session.revision, action.date, action.description, action.prescription);
      else if (action.kind === 'verify') await exportApi.reconcile(action.session.id);
      else await exportApi.remove(action.session.id);
      if (action.kind === 'verify' && action.session.status === 'deleted') return `Séance supprimée #${action.session.id} : état Garmin vérifié.`;
      if (action.kind === 'remove') return `Séance #${action.session.id} : retrait demandé, consulter l’état Garmin.`;
      const view = await workoutApi.inspect(action.session.id);
      queryClient.setQueryData<WorkoutView>(workoutKey(action.session.id), view);
      return action.kind === 'edit' ? `Séance #${action.session.id} modifiée dans Arete (${action.date}) ; aucun envoi Garmin.` : `Séance #${action.session.id} : vérification Garmin, état ${exportLabel(view.export)}.`;
    },
    onSuccess: text => onResult?.(text),
    onError: error => onResult?.(`Action interrompue : ${readableError(error)}`),
    onSettled: () => { markWorkout('workout:action-settled'); measureWorkout('workout:action-total', 'workout:action-start', 'workout:action-settled'); invalidateAfterSession(queryClient); },
  });
  const run = async (action: Action) => {
    // Mutation state is synchronous: a rapid second click cannot enqueue another write.
    if (queryClient.isMutating({ mutationKey: key })) return false;
    try { await mutation.mutateAsync(action); return true; }
    catch { return false; } // The mutation exposes the error inline and records it in the originating thread.
  };
  return { run, pendingIds, pendingLabels, busy, error: mutation.error ? readableError(mutation.error) : undefined, reset: mutation.reset };
}
