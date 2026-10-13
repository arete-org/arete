import { STATE_LABELS } from './sessionForm';
import { useRef, useState } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, Input, Modal, ModalHeader } from '@/components/ui';
import { StepList } from '@/components/WorkoutCard';
import { useWorkoutActions } from '@/hooks/useWorkoutActions';
import { garminApi } from '@/lib/api';
import { exportApi } from '@/lib/documents';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { GENERIC_STEPS_LABEL, mergeWorkout, PARSED_STEPS_LABEL, workoutApi, workoutKey } from '@/lib/workouts';
import type { Prescription } from '@/lib/documents';
import type { PlannedState } from '@/lib/sessionMatch';
import type { ActualSession, PlannedSession } from '@/types';
import {
  dayLabel,
  planningError,
  saveFields,
  sessionDraft,
  sessionTitle,
  sportLabel,
} from './sessionForm';
import { GarminState } from './WeekBoard';

export function SessionDetail({
  session,
  state,
  realised,
  onClose,
  onEdit,
  onMove,
  onDuplicate,
  onChanged,
  onDeleted,
}: {
  session: PlannedSession;
  state: PlannedState;
  realised: ActualSession | null;
  onClose: () => void;
  /** Receives the steps read from the description, to start the editor from them. */
  onEdit: (parsed?: Prescription) => void;
  onMove: () => void;
  onDuplicate: () => void;
  onChanged: (session: PlannedSession, message: string) => void;
  onDeleted: (message: string) => void;
}) {
  const client = useQueryClient();
  const polling = useRef<number | null>(null);
  const actions = useWorkoutActions();
  const pending = actions.pendingIds.has(session.id);
  const busy = useIsMutating({ mutationKey: ['workout-action'] }) > 0;
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removeGarmin, setRemoveGarmin] = useState(true);
  const query = useQuery({
    queryKey: workoutKey(session.id),
    queryFn: () => workoutApi.inspect(session.id),
    retry: false,
    staleTime: 0,
    structuralSharing: (old, next) =>
      mergeWorkout(
        old as import('@/lib/workouts').WorkoutView | undefined,
        next as import('@/lib/workouts').WorkoutView,
      ),
    refetchInterval: (q) => {
      if (!pending && q.state.data?.export?.state !== 'working') {
        polling.current = null;
        return false;
      }
      polling.current ??= Date.now();
      return Date.now() - polling.current < 150_000 ? 1000 : false;
    },
  });
  const view = query.data;
  const latestRevision = session.revision ?? 1;
  const blocked =
    busy ||
    !view ||
    !!query.error ||
    ['working', 'uncertain', 'conflict'].includes(view.export?.state ?? '');
  const hasGarmin = !!view?.export && view.export.state !== 'removed';
  const edit = () =>
    onEdit((view?.session.parsed && view.session.prescription) || undefined);
  const status = useMutation({
    mutationKey: ['workout-action', 'planning'],
    retry: false,
    mutationFn: (value: 'completed' | 'skipped' | 'pending') =>
      garminApi.setPlannedStatus(session.id, value, latestRevision),
    onSuccess: (updated) => {
      invalidateAfterSession(client);
      onChanged(
        updated,
        updated.status === 'completed'
          ? 'Séance marquée réalisée.'
          : updated.status === 'skipped'
            ? 'Séance marquée sautée.'
            : 'Séance remise en prévue.',
      );
    },
  });
  const deletion = useMutation({
    mutationKey: ['workout-action', 'planning'],
    retry: false,
    mutationFn: async () => {
      await garminApi.deletePlanned(session.id, latestRevision);
      if (!removeGarmin || !hasGarmin) return 'Séance supprimée du planning.';
      // Deletion is committed. A Garmin failure must never invite replaying it.
      try {
        const result = await exportApi.remove(session.id);
        return result.state === 'removed'
          ? 'Séance supprimée du planning et retrait Garmin confirmé.'
          : 'Séance supprimée du planning. Le retrait Garmin reste à vérifier.';
      } catch (error) {
        return `Séance supprimée du planning. Retrait Garmin à terminer : ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    onSuccess: (result) => {
      invalidateAfterSession(client);
      onDeleted(result);
    },
  });
  const runGarmin = async (kind: 'export' | 'verify') => {
    if (!view) return;
    const ok = await actions.run(
      kind === 'verify'
        ? { kind, session: view.session }
        : { kind, sessions: [view.session], deviceId: null },
    );
    if (ok)
      setMessage(
        kind === 'verify'
          ? 'État Garmin vérifié.'
          : 'Envoi terminé. Consulte le statut Garmin ci-dessous.',
      );
  };
  return (
    <>
      <Modal
        mobileSheet
        open
        onClose={() => {
          if (!busy) onClose();
        }}
        label="Détail de la séance"
        className="planning-dialog max-w-[600px] max-h-[92dvh] overflow-y-auto"
      >
        <ModalHeader
          title={dayLabel(session.date)}
          onClose={() => {
            if (!busy) onClose();
          }}
          tone="text-text-muted"
        />
        <div className="space-y-5">
          <h2 className="text-2xl font-semibold break-words">{sessionTitle(session)}</h2>
          <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
            <span className="ui-inset px-2 py-1">{sportLabel(session.sport)}</span>
            <span className="ui-inset px-2 py-1">{STATE_LABELS[state]}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button strong disabled={blocked} onClick={edit}>
              Modifier
            </Button>
            <Button disabled={blocked} onClick={onMove}>
              Déplacer
            </Button>
            <Button variant="ghost" disabled={busy || !view} onClick={onDuplicate}>
              Dupliquer
            </Button>
          </div>
          {query.isPending && (
            <p role="status" className="text-sm text-text-muted">
              Lecture de la séance…
            </p>
          )}
          {query.error && (
            <div role="alert" className="text-sm text-danger-red">
              <p>{query.error.message}</p>
              <Button onClick={() => void query.refetch()}>Réessayer la lecture</Button>
            </div>
          )}
          {view?.session.prescription ? (
            <section className="border-t border-border pt-5">
              <h3 className="font-semibold text-sm">Déroulé de la séance</h3>
              <div className="planning-steps">
                <StepList prescription={view.session.prescription} />
              </div>
              {view.session.parsed && (
                <p className="mt-3 text-xs text-text-muted">{PARSED_STEPS_LABEL}.</p>
              )}
              {view.session.derived && (
                <p className="mt-3 text-xs text-text-muted">
                  {view.session.needs_steps
                    ? `${GENERIC_STEPS_LABEL}.`
                    : 'Étapes dérivées des objectifs du planning.'}
                </p>
              )}
              {view.session.needs_steps && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-warning-orange">{view.session.reason}</p>
                  <Button disabled={blocked} onClick={edit}>
                    Compléter les étapes
                  </Button>
                </div>
              )}
            </section>
          ) : (
            view && (
              <p className="text-sm text-text-secondary">
                {view.session.reason || 'Aucune étape définie. Tu peux compléter la séance.'}
              </p>
            )
          )}
          <section className="ui-inset p-4 space-y-3" aria-label="Garmin Connect">
            <GarminState state={view} unavailable={!!query.error} />
            {view?.export?.error && (
              <p role="alert" className="text-xs text-danger-red">
                {view.export.error}
              </p>
            )}
            <p className="text-xs text-text-muted">
              Une programmation Garmin Connect est récupérée par la montre lors de sa prochaine
              synchronisation.
            </p>
            <div className="flex flex-wrap gap-2">
              {view?.session.exportable && (
                <Button
                  disabled={blocked}
                  loading={pending}
                  onClick={() => void runGarmin('export')}
                >
                  {view.export?.state === 'dirty' ? 'Mettre à jour Garmin' : 'Envoyer à Garmin'}
                </Button>
              )}
              {view?.export && (
                <Button variant="ghost" disabled={busy} onClick={() => void runGarmin('verify')}>
                  Vérifier Garmin
                </Button>
              )}
            </div>
          </section>
          {realised && (
            <Link
              className="block min-h-11 text-sm text-neon-cyan"
              to={realised.id < 0 ? '/log' : `/log/sessions/${realised.id}`}
            >
              Consulter l’activité réalisée →
            </Link>
          )}
          <div className="flex flex-wrap gap-2">
            {state !== 'done' && (
              <Button
                disabled={blocked}
                onClick={() => {
                  if (!client.isMutating({ mutationKey: ['workout-action'] }))
                    status.mutate('completed');
                }}
              >
                Marquer réalisée
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={blocked}
              onClick={() => {
                if (!client.isMutating({ mutationKey: ['workout-action'] }))
                  status.mutate(
                    session.status === 'pending' || session.status === 'modified'
                      ? 'skipped'
                      : 'pending',
                  );
              }}
            >
              {session.status === 'pending' || session.status === 'modified'
                ? 'Sauter'
                : 'Remettre en prévue'}
            </Button>
          </div>
          <Button
            variant="ghost"
            className="text-danger-red"
            disabled={blocked}
            onClick={() => setConfirmDelete(true)}
          >
            Supprimer la séance
          </Button>
          {(status.error || deletion.error || actions.error) && (
            <p role="alert" className="text-sm text-danger-red">
              {planningError(status.error) || planningError(deletion.error) || actions.error}
            </p>
          )}
          {message && (
            <p role="status" className="text-sm text-text-secondary">
              {message}
            </p>
          )}
        </div>
      </Modal>
      <Modal
        mobileSheet
        open={confirmDelete}
        onClose={() => {
          if (!busy) setConfirmDelete(false);
        }}
        label="Supprimer cette séance ?"
        className="planning-dialog max-w-[520px]"
      >
        <ModalHeader
          title="Supprimer cette séance ?"
          onClose={() => {
            if (!busy) setConfirmDelete(false);
          }}
          tone="text-text-primary"
        />
        <div className="space-y-5">
          <p className="font-semibold break-words">{sessionTitle(session)}</p>
          <p className="text-sm text-text-muted">{dayLabel(session.date)}</p>
          <p className="text-sm text-text-secondary">
            La séance sera retirée du planning. Aucune activité déjà réalisée ne sera supprimée.
          </p>
          {hasGarmin && (
            <div className="ui-inset p-4">
              <label className="flex items-center gap-3 min-h-11 text-sm">
                <input
                  type="checkbox"
                  checked={removeGarmin}
                  disabled={busy}
                  onChange={(e) => setRemoveGarmin(e.target.checked)}
                />
                Retirer aussi de Garmin Connect
              </label>
              <p className="text-xs text-text-muted">
                Si le retrait échoue, tu pourras le terminer depuis le planning.
              </p>
            </div>
          )}
          {deletion.error && (
            <p role="alert" className="text-sm text-danger-red">
              {planningError(deletion.error)}
            </p>
          )}
          <div className="flex flex-wrap justify-between gap-3">
            <Button disabled={busy} onClick={() => setConfirmDelete(false)}>
              Conserver la séance
            </Button>
            <Button
              variant="danger"
              strong
              loading={deletion.isPending}
              disabled={blocked}
              onClick={() => {
                if (!client.isMutating({ mutationKey: ['workout-action'] })) deletion.mutate();
              }}
            >
              Supprimer
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function MoveSession({
  session,
  date,
  restDays,
  onClose,
  onMoved,
}: {
  session: PlannedSession;
  date?: string;
  restDays: string[];
  onClose: () => void;
  onMoved: (session: PlannedSession) => void;
}) {
  const client = useQueryClient();
  const busy = useIsMutating({ mutationKey: ['workout-action'] }) > 0;
  const [target, setTarget] = useState(date ?? session.date);
  const rest =
    target &&
    restDays.includes(
      new Date(`${target}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase(),
    );
  const mutation = useMutation({
    mutationKey: ['workout-action', 'planning'],
    retry: false,
    mutationFn: () =>
      garminApi.updatePlanned(
        session.id,
        session.revision ?? 1,
        saveFields(sessionDraft(target, session)),
      ),
    onSuccess: (updated) => {
      invalidateAfterSession(client);
      onMoved(updated);
    },
  });
  return (
    <Modal
      mobileSheet
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      label="Déplacer la séance"
      className="planning-dialog max-w-[520px]"
    >
      <ModalHeader
        title="Déplacer la séance"
        onClose={() => {
          if (!busy) onClose();
        }}
      />
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!client.isMutating({ mutationKey: ['workout-action'] })) mutation.mutate();
        }}
      >
        <p className="font-semibold break-words">{sessionTitle(session)}</p>
        <p className="text-sm text-text-muted">Actuellement : {dayLabel(session.date)}</p>
        <label className="planning-field">
          Nouvelle date
          <Input
            type="date"
            required
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        {rest && (
          <p className="ui-inset p-4 text-sm text-warning-orange">
            Ce jour est un jour de repos prévu. Tu peux conserver ce choix ou choisir une autre
            date.
          </p>
        )}
        <p className="text-xs text-text-muted">
          Si la séance est programmée dans Garmin, sa date devra ensuite être mise à jour.
        </p>
        {mutation.error && (
          <p role="alert" className="text-sm text-danger-red">
            {planningError(mutation.error)}
          </p>
        )}
        <div className="flex justify-between gap-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button
            type="submit"
            strong
            loading={mutation.isPending}
            disabled={busy || target === session.date}
          >
            Déplacer
          </Button>
        </div>
      </form>
    </Modal>
  );
}
