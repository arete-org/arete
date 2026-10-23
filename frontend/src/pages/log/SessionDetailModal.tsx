import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Link, Unlink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState, LoadingState } from '@/components';
import { Modal, ModalHeader, RPE_TEXT, rpeTone } from '@/components/ui';
import { strengthApi } from '@/lib/api';
import { parseLocalDate } from '@/lib/dates';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { StrengthExercises } from './StrengthExercises';

interface SessionDetailModalProps {
  sessionId: number | null;
  onClose: () => void;
}

export function SessionDetailModal({ sessionId, onClose }: SessionDetailModalProps) {
  const queryClient = useQueryClient();
  const open = sessionId !== null;

  const { data: session, isLoading } = useQuery({
    queryKey: ['strengthSession', sessionId],
    queryFn: () => strengthApi.getSession(sessionId!),
    enabled: open,
  });

  const { data: garminCandidates } = useQuery({
    queryKey: ['garminCandidates', sessionId],
    queryFn: () => strengthApi.getGarminCandidates(sessionId!),
    enabled: open,
  });

  const linkMutation = useMutation({
    mutationFn: (garminId: number | null) => strengthApi.linkToGarmin(sessionId!, garminId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strengthSession', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['garminCandidates', sessionId] });
      // A link settles the activity's draft, its same-day warning and the game.
      invalidateAfterSession(queryClient);
    },
  });

  return (
    <Modal open={open} onClose={onClose} className="max-w-2xl max-h-[80vh] overflow-y-auto">
      <ModalHeader
        title="Détail de la séance"
        tone="text-neon-gold"
        onClose={onClose}
      />

      {isLoading ? (
        <LoadingState />
      ) : session ? (
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b border-text-muted/20 pb-4">
            <div>
              <div className="text-sm font-sans text-text-muted">
                {parseLocalDate(session.date).toLocaleDateString('fr-FR', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </div>
              <div className="text-xl font-sans text-text-primary mt-1">{session.name || 'Séance'}</div>
            </div>
            <div className="text-right">
              {session.duration_min && (
                <div className="text-sm font-sans text-text-muted">{session.duration_min} min</div>
              )}
              {session.overall_rpe && (
                <div className={cn('text-sm font-sans mt-1', RPE_TEXT[rpeTone(session.overall_rpe)])}>
                  RPE {session.overall_rpe}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            <Stat value={session.exercises_count || session.exercises?.length || 0} label="Exercices" tone="text-neon-cyan" />
            <Stat value={session.total_sets || 0} label="Séries" tone="text-neon-gold" />
            <Stat
              value={`${((session.total_volume || 0) / 1000).toFixed(1)}k`}
              label="Volume (kg)"
              tone="text-success-green"
            />
          </div>

          {session.exercises && session.exercises.length > 0 && (
            <div>
              <h3 className="text-sm font-sans font-medium text-text-secondary mb-3">Exercices</h3>
              <StrengthExercises exercises={session.exercises} />
            </div>
          )}

          {session.notes && (
            <div>
              <h3 className="text-sm font-sans font-medium text-text-secondary mb-2">Notes</h3>
              <p className="text-sm text-text-secondary font-sans">{session.notes}</p>
            </div>
          )}

          <div className="border-t border-text-muted/20 pt-4">
            <h3 className="text-sm font-sans font-medium text-text-secondary mb-3 flex items-center gap-2">
              <Link className="w-4 h-4" />
              Synchro Garmin
            </h3>

            {session.garmin_activity_id ? (
              <div className="flex items-center justify-between p-3 bg-success-green/10 rounded border border-success-green/30">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-success-green" />
                  <span className="text-sm font-sans text-success-green">
                    Liée à l'activité Garmin n°{session.garmin_activity_id}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => linkMutation.mutate(null)}
                  disabled={linkMutation.isPending}
                  className="p-2 hover:bg-danger-red/20 rounded text-danger-red transition-colors"
                  title="Délier"
                  aria-label="Délier l’activité Garmin"
                >
                  <Unlink aria-hidden="true" className="w-4 h-4" />
                </button>
              </div>
            ) : garminCandidates?.candidates && garminCandidates.candidates.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-text-muted font-sans mb-2">
                  {garminCandidates.candidates.length === 1
                    ? '1 activité Garmin correspondante :'
                    : `${garminCandidates.candidates.length} activités Garmin correspondantes :`}
                </p>
                {garminCandidates.candidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => linkMutation.mutate(candidate.id)}
                    disabled={linkMutation.isPending}
                    className="w-full p-3 bg-abyss hover:bg-neon-cyan/10 rounded border border-text-muted/20 hover:border-neon-cyan/50 transition-colors text-left"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-sans text-text-primary">{candidate.date}</span>
                        <span className="text-xs font-sans text-text-muted ml-2">
                          ({Math.round(candidate.duration_seconds / 60)} min)
                        </span>
                      </div>
                      <span className="text-xs font-sans text-neon-cyan">Lier</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-3 bg-abyss rounded border border-text-muted/20">
                <p className="text-sm font-sans text-text-muted text-center">Aucune activité Garmin correspondante</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <EmptyState message="Séance introuvable" />
      )}
    </Modal>
  );
}

function Stat({ value, label, tone }: { value: number | string; label: string; tone: string }) {
  return (
    <div className="text-center p-2 sm:p-3 bg-abyss rounded border border-text-muted/20">
      <div className={cn('text-lg sm:text-2xl font-sans', tone)}>{value}</div>
      <div className="text-[10px] sm:text-xs font-sans text-text-muted">{label}</div>
    </div>
  );
}
