import { PlayerSummary } from '@/components/PlayerSummary';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Dumbbell, Heart, Sparkles } from 'lucide-react';
import { EmptyState, ErrorState, MuscleMap } from '@/components';
import { PushOffer } from '@/components/PushOffer';
import { Button, Modal, ModalHeader, Panel, Skeleton } from '@/components/ui';
import { settingsApi, strengthApi } from '@/lib/api';
import { CardioTab, ExerciseProgress, LogSessionModal, SessionDetailModal, SessionRow, StrengthDrafts, WeeklyVolumeTracker } from './log/index';
import { OPENED_IN_JOURNAL, useEntryClose } from './log/entryClose';
import { invalidateAfterSession, qk, strengthDraftsQuery, strengthSessionsQuery } from '@/lib/queryKeys';
import type { StrengthDraft } from '@/types';

type Tab = 'force' | 'cardio';

/** The heat map reads the last week of work. */
const MUSCLE_WINDOW_DAYS = 7;

const TABS: { id: Tab; label: string; icon: typeof Dumbbell }[] = [
  { id: 'force', label: 'Force', icon: Dumbbell },
  { id: 'cardio', label: 'Cardio', icon: Heart },
];

export function LogPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: Tab = searchParams.get('tab') === 'cardio' ? 'cardio' : 'force';
  const setActiveTab = (tab: Tab) => setSearchParams(tab === 'force' ? {} : { tab }, { replace: true });
  const [toDelete, setToDelete] = useState<number | null>(null);
  const showNewSession = searchParams.get('new') === '1';
  const setShowNewSession = (open: boolean) => setSearchParams(previous => {
    const next = new URLSearchParams(previous);
    if (open) next.set('new', '1'); else next.delete('new');
    return next;
  }, { replace: true, state: open ? OPENED_IN_JOURNAL : undefined });
  const closeNewSession = useEntryClose(() => setShowNewSession(false));
  const sessionParam = searchParams.get('session');
  const selectedSessionId = sessionParam && /^\d+$/.test(sessionParam) && Number.isSafeInteger(Number(sessionParam)) ? Number(sessionParam) : null;
  const setSelectedSessionId = (id: number | null) => setSearchParams(previous => { const next = new URLSearchParams(previous); if (id === null) next.delete('session'); else next.set('session', String(id)); return next; });
  // The exercise in the progress panel lives in the URL, so a record elsewhere can link to it.
  const exerciseParam = searchParams.get('exercise');
  const selectedExerciseId = exerciseParam && /^\d+$/.test(exerciseParam) ? Number(exerciseParam) : null;
  const setSelectedExerciseId = (id: number | null) => setSearchParams(previous => { const next = new URLSearchParams(previous); if (id === null) next.delete('exercise'); else next.set('exercise', String(id)); return next; }, { replace: true });

  // A Garmin strength session awaiting its loads opens from the Journal or a link (?draft=).
  const draftParam = searchParams.get('draft');
  const setDraftId = (id: number | null) => setSearchParams(previous => { const next = new URLSearchParams(previous); if (id === null) next.delete('draft'); else next.set('draft', String(id)); return next; }, { replace: true, state: id === null ? undefined : OPENED_IN_JOURNAL });
  const closeDraft = useEntryClose(() => setDraftId(null));

  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });
  const draftsQuery = useQuery(strengthDraftsQuery);
  const drafts = draftsQuery.data?.items ?? [];
  // Kept once found: completing it drops it from the list, not from its own screen.
  const listedDraft = drafts.find((d) => String(d.id) === draftParam) ?? null;
  const [keptDraft, setKeptDraft] = useState<StrengthDraft | null>(null);
  if (listedDraft && listedDraft !== keptDraft) setKeptDraft(listedDraft);
  const openDraft = listedDraft ?? (keptDraft && String(keptDraft.id) === draftParam ? keptDraft : null);

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
      <div className="page-content analytics-page">
        <header><p className="page-eyebrow">Chaque séance compte</p><h1 className="page-title">Journal</h1><p className="mt-2 text-sm text-text-muted">Tes séances, tes progrès et ton équilibre musculaire.</p></header>
        <div className="journal-actions">
          <Button variant="gold" strong onClick={() => setShowNewSession(true)}>
            <Sparkles className="w-4 h-4" />
            Saisir une séance
          </Button>
        </div>

        <PlayerSummary />
        <div className="flex gap-1" role="group" aria-label="Type de séances">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
              className="analysis-tab flex items-center gap-2"
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'force' && (
          <StrengthDrafts drafts={drafts} total={draftsQuery.data?.total ?? 0} onComplete={setDraftId} paused={openDraft !== null} />
        )}

        {activeTab === 'force' && (
          <div className="analysis-grid">
            <div className="space-y-6">
              <Panel title={`Zones travaillées · ${MUSCLE_WINDOW_DAYS} derniers jours`}>
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

            <div className="space-y-6">
              <Panel title="Séances récentes" delay={0.3}>
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
                  {/* Under the five rows: the session that just arrived comes first. */}
                  {sessions.length > 0 && <PushOffer moment="session" />}
                  {sessionsQuery.isSuccess && sessions.length === 0 && (
                    <EmptyState message="AUCUNE SÉANCE" action="Saisis ta première séance de muscu" />
                  )}
                </div>
              </Panel>
              <ExerciseProgress exerciseId={selectedExerciseId} onSelect={setSelectedExerciseId} />
            </div>
          </div>
        )}

        {activeTab === 'cardio' && (
          <CardioTab
            showManual={showNewSession}
            onManualChange={(open) => (open ? setShowNewSession(true) : closeNewSession())}
            // The coach's word on the saved session appears on this tab: stay.
            onManualSaved={() => setShowNewSession(false)}
          />
        )}
      </div>

      <LogSessionModal open={showNewSession && activeTab === 'force'} onClose={closeNewSession} />
      {openDraft && <LogSessionModal key={openDraft.id} open draft={openDraft} onClose={closeDraft} />}
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
