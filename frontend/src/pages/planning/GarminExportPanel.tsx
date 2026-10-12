import { useQuery } from '@tanstack/react-query';
import { exportApi } from '@/lib/documents';
import { exportLabel } from '@/lib/workouts';
import { useWorkoutActions } from '@/hooks/useWorkoutActions';
import { Button } from '@/components/ui';

/** Deleted sessions retain their cleanup controls until Garmin confirms removal. */
export function GarminExportPanel() {
  const statuses = useQuery({
    queryKey: ['garmin-exports'],
    queryFn: exportApi.statuses,
    retry: false,
  });
  const actions = useWorkoutActions();
  const pending =
    statuses.data?.filter((state) => state.deleted && state.state !== 'removed') ?? [];
  if (!pending.length && !statuses.error && !actions.error) return null;
  return (
    <section className="planning-cleanup glass-panel" aria-label="Retraits Garmin à terminer">
      {statuses.error && (
        <p role="alert" className="text-xs text-danger-red">
          {statuses.error.message}
        </p>
      )}
      {pending.length > 0 && (
        <>
          <h2 className="text-[13px] font-semibold text-warning-orange">
            {pending.length} retrait{pending.length > 1 ? 's' : ''} Garmin à terminer
          </h2>
          <p className="text-xs text-text-muted mt-2">
            {pending.length === 1
              ? 'La séance a été supprimée du planning.'
              : 'Les séances ont été supprimées du planning.'}
          </p>
          <details className="mt-2">
            <summary className="inline-flex items-center min-h-11 px-4 text-sm font-medium text-neon-cyan cursor-pointer">
              Gérer le retrait{pending.length > 1 ? 's' : ''}
            </summary>
            <div className="space-y-3">
              {pending.map((state) => (
                <div key={state.session_id} className="border-t border-border pt-3 text-sm">
                  <p>
                    {state.description || `Séance #${state.session_id}`} · {exportLabel(state)}
                  </p>
                  {state.error && <p className="text-danger-red">{state.error}</p>}
                  <div className="flex flex-wrap gap-2 mt-2">
                    <Button
                      disabled={actions.busy}
                      onClick={() =>
                        void actions.run({
                          kind: 'remove',
                          session: {
                            id: state.session_id,
                            revision: 1,
                            date: '',
                            sport: '',
                            description: '',
                            status: 'deleted',
                          },
                        })
                      }
                    >
                      Retirer de Garmin Connect
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={actions.busy}
                      onClick={() =>
                        void actions.run({
                          kind: 'verify',
                          session: {
                            id: state.session_id,
                            revision: 1,
                            date: '',
                            sport: '',
                            description: '',
                            status: 'deleted',
                          },
                        })
                      }
                    >
                      Vérifier Garmin
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
      {actions.error && (
        <p role="alert" className="text-xs text-danger-red">
          {actions.error}
        </p>
      )}
    </section>
  );
}
