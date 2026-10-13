import { PlayerSummary } from '@/components/PlayerSummary';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Dumbbell, Heart, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, MuscleMap } from '@/components';
import { Button, Modal, ModalHeader, Panel, Skeleton } from '@/components/ui';
import { settingsApi, strengthApi } from '@/lib/api';
import { CardioTab, ExerciseProgress, LogSessionModal, SessionDetailModal, SessionRow, WeeklyVolumeTracker } from './log/index';
import { invalidateAfterSession, qk, strengthSessionsQuery } from '@/lib/queryKeys';

type Tab = 'force' | 'cardio';

/** The heat map reads the last week of work. */
const MUSCLE_WINDOW_DAYS = 7;

const TABS: { id: Tab; label: string; icon: typeof Dumbbell }[] = [
  { id: 'force', label: 'FORCE', icon: Dumbbell },
  { id: 'cardio', label: 'CARDIO', icon: Heart },
];

export function LogPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: Tab = searchParams.get('tab') === 'cardio' ? 'cardio' : 'force';
  const setActiveTab = (tab: Tab) => setSearchParams(tab === 'force' ? {} : { tab }, { replace: true });
  const [toDelete, setToDelete] = useState<number | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const sessionParam = searchParams.get('session');
  const selectedSessionId = sessionParam && /^\d+$/.test(sessionParam) && Number.isSafeInteger(Number(sessionParam)) ? Number(sessionParam) : null;
  const setSelectedSessionId = (id: number | null) => setSearchParams(previous => { const next = new URLSearchParams(previous); if (id === null) next.delete('session'); else next.set('session', String(id)); return next; });
  // The exercise in the progress panel lives in the URL, so a record elsewhere can link to it.
  const exerciseParam = searchParams.get('exercise');
  const selectedExerciseId = exerciseParam && /^\d+$/.test(exerciseParam) ? Number(exerciseParam) : null;
  const setSelectedExerciseId = (id: number | null) => setSearchParams(previous => { const next = new URLSearchParams(previous); if (id === null) next.delete('exercise'); else next.set('exercise', String(id)); return next; }, { replace: true });

  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });

  const muscleQuery = useQuery({
    queryKey: qk.muscleStats(MUSCLE_WINDOW_DAYS),
    queryFn: () => strengthApi.getMuscleStats(MUSCLE_WINDOW_DAYS),
  });

  // The whole list: the weekly volume needs every session of the week, the list shows 5.
  const sessionsQuery = useQuery(strengthSessionsQuery);

  const deleteSessionMutation = useMutation({
    mutationFn: (sessionId: number) => strengthApi.deleteSession(sessionId),
    onSuccess: () => {
      invalidateAfterSession(queryClient);
      setSelectedSessionId(null);
      setToDelete(null);
    },
  });

  if (sessionsQuery.isError) {
    return <ErrorState message="ÉCHEC DU CHARGEMENT DES SÉANCES" onRetry={() => sessionsQuery.refetch()} />;
  }

  const sessions = sessionsQuery.data ?? [];

  return (
    <div className="page-shell bg-void">
      <div className="page-content">
        <header className="flex justify-between items-center mb-4 sm:mb-8 animate-fade-down">
          <h1 className="page-title">Journal</h1>
          {activeTab === 'force' && (
            <Button variant="gold" onClick={() => setShowNewSession(true)}>
              <Sparkles className="w-4 h-4" />
              SAISIR UNE SÉANCE
            </Button>
          )}
        </header>

        <PlayerSummary />
        <div className="flex gap-1 mb-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-t text-sm font-sans transition-all',
                activeTab === tab.id
                  ? 'bg-neon-gold/10 text-neon-gold border-b-2 border-neon-gold'
                  : 'text-text-muted hover:text-text-secondary'
              )}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'force' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-8">
            <div className="space-y-4 sm:space-y-8">
              <Panel title={`ZONES TRAVAILLÉES (${MUSCLE_WINDOW_DAYS} DERNIERS JOURS)`}>
                {muscleQuery.isPending ? (
                  <Skeleton label="Chargement des zones travaillées" lines={4} />
                ) : muscleQuery.isError ? (
                  <ErrorState message="VOLUME INDISPONIBLE" onRetry={() => muscleQuery.refetch()} />
                ) : (
                  <MuscleMap muscles={muscleQuery.data?.muscles ?? []} />
                )}
              </Panel>
              {sessionsQuery.isPending ? (
                <Panel><Skeleton label="Chargement du volume de la semaine" /></Panel>
              ) : (
                <WeeklyVolumeTracker sessions={sessions} targetKg={settings?.weekly_volume_target_kg ?? 20000} />
              )}
            </div>

            <div className="space-y-4 sm:space-y-8">
              <Panel title="SÉANCES RÉCENTES" delay={0.3}>
                <div className="space-y-3">
                  {sessionsQuery.isPending && <Skeleton label="Chargement des séances récentes" lines={3} />}
                  {sessions.slice(0, 5).map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      onView={() => setSelectedSessionId(session.id)}
                      onDelete={() => setToDelete(session.id)}
                    />
                  ))}
                  {sessionsQuery.isSuccess && sessions.length === 0 && (
                    <EmptyState message="AUCUNE SÉANCE" action="Saisis ta première séance de muscu" />
                  )}
                </div>
              </Panel>
              <ExerciseProgress exerciseId={selectedExerciseId} onSelect={setSelectedExerciseId} />
            </div>
          </div>
        )}

        {activeTab === 'cardio' && <CardioTab />}
      </div>

      <LogSessionModal open={showNewSession} onClose={() => setShowNewSession(false)} />
      <Modal open={toDelete !== null} onClose={() => setToDelete(null)} className="max-w-sm p-4 sm:p-6">
        <ModalHeader title="SUPPRIMER LA SÉANCE" onClose={() => setToDelete(null)} className="mb-4" />
        <p className="text-sm font-sans text-text-secondary mb-6">
          Cette séance et ses séries seront définitivement supprimées.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={() => setToDelete(null)}>
            Annuler
          </Button>
          <Button
            variant="danger"
            loading={deleteSessionMutation.isPending}
            onClick={() => toDelete !== null && deleteSessionMutation.mutate(toDelete)}
          >
            Supprimer
          </Button>
        </div>
      </Modal>
      <SessionDetailModal sessionId={selectedSessionId} onClose={() => setSelectedSessionId(null)} />
    </div>
  );
}
