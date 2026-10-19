import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { fetchAPI } from '@/lib/api';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';
import { sportLabel } from '@/lib/fr';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';

interface Snapshot {
  id: number;
  date: string;
  sport: string;
  session_type: string;
  summary: string | null;
  description: string | null;
  target_duration_min: number | null;
  target_distance_km: number | null;
  target_hr_zone: string | null;
  target_intensity: string | null;
  status: string;
}
interface ChangeSet {
  id: string;
  revision: number;
  before: Snapshot[];
  after: Snapshot[];
  expires_at: string;
  state: 'pending' | 'applied' | 'dismissed' | 'expired';
  receipt: { remote: string } | null;
}
const status = {
  pending: 'Prévue',
  modified: 'Ajustée',
  skipped: 'Abandonnée',
  completed: 'Terminée',
};
function SessionSummary({ session }: { session: Snapshot }) {
  return (
    <div className="min-w-0 space-y-1 text-sm">
      <p className="font-medium">
        {new Date(`${session.date}T12:00:00`).toLocaleDateString('fr-FR', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        })}{' '}
        · {sportLabel(session.sport)}
      </p>
      <p className="text-text-secondary break-words">
        {session.summary ||
          (session.target_duration_min ? `${session.target_duration_min} min` : 'Séance prévue')}
      </p>
      {session.description && session.description !== session.summary && (
        <p className="text-text-secondary break-words">{session.description}</p>
      )}
      <dl className="grid grid-cols-2 gap-x-2 text-xs text-text-secondary">
        <dt>Type de séance</dt>
        <dd>{SESSION_TYPE_LABEL[session.session_type] ?? session.session_type}</dd>
        <dt>Durée cible</dt>
        <dd>
          {session.target_duration_min ? `${session.target_duration_min} min` : 'Non définie'}
        </dd>
        <dt>Distance cible</dt>
        <dd>
          {session.target_distance_km
            ? `${session.target_distance_km.toLocaleString('fr-FR')} km`
            : 'Non définie'}
        </dd>
        <dt>Zone cible</dt>
        <dd>{session.target_hr_zone || 'Non définie'}</dd>
        <dt>Intensité cible</dt>
        <dd>
          {({ easy: 'Facile', moderate: 'Modérée', hard: 'Difficile' } as Record<string, string>)[
            session.target_intensity ?? ''
          ] ?? 'Non définie'}
        </dd>
      </dl>
      <p className="text-xs text-text-muted">
        {status[session.status as keyof typeof status] ?? session.status}
      </p>
    </div>
  );
}

/** One review body for Planning and the scheduled mission's existing approval. */
export function PlanChangeReview({
  id,
  readOnly = false,
  onReady,
}: {
  id: string;
  readOnly?: boolean;
  onReady?: (ready: boolean) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['plan-change-set', id],
    queryFn: () => fetchAPI<ChangeSet>(`/coach/plan-changes/${id}`),
    retry: false,
  });
  const proposal = query.data;
  const [expiredId, setExpiredId] = useState<string | null>(null);
  useEffect(() => {
    if (!proposal) return;
    const timer = window.setTimeout(
      () => setExpiredId(id),
      Math.max(0, Math.min(2_147_483_647, Date.parse(proposal.expires_at) - Date.now() + 1)),
    );
    return () => window.clearTimeout(timer);
  }, [id, proposal]);
  const ready = proposal?.state === 'pending' && expiredId !== id && !query.isError;
  useEffect(() => {
    onReady?.(ready);
  }, [onReady, ready]);
  const action = useMutation({
    mutationKey: ['workout-action', 'change-set', id],
    retry: false,
    mutationFn: (kind: 'apply' | 'dismiss') =>
      fetchAPI(`/coach/plan-changes/${id}/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ revision: proposal!.revision, operation_id: id }),
      }),
    onSettled: async () => {
      invalidateAfterSession(client);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['plan-change-set', id] }),
        client.invalidateQueries({ queryKey: ['coaching-attention'] }),
      ]);
    },
  });
  if (query.isPending) return <p role="status">Chargement de la proposition…</p>;
  if (query.isError || !proposal)
    return (
      <p role="alert">
        Proposition indisponible.{' '}
        <button className="min-h-11 underline" onClick={() => void query.refetch()}>
          Réessayer
        </button>
      </p>
    );
  return (
    <section className="space-y-4" aria-label="Ajustement du planning">
      <div>
        <h3 className="text-lg font-medium">
          Ajuster {proposal.before.length} séance{proposal.before.length > 1 ? 's' : ''}
        </h3>
        <p className="mt-1 text-sm text-text-muted">
          Tous les changements sont enregistrés ensemble dans Arete.
        </p>
      </div>
      {proposal.before.map((before, index) => (
        <div
          key={before.id}
          className="grid gap-3 rounded-[var(--radius-control)] border border-border p-4 sm:grid-cols-2"
        >
          <div>
            <p className="mb-2 text-xs text-text-muted">Avant</p>
            <SessionSummary session={before} />
          </div>
          <div>
            <p className="mb-2 text-xs text-neon-cyan">Après</p>
            <SessionSummary session={proposal.after[index]} />
          </div>
        </div>
      ))}
      {proposal.state === 'applied' ? (
        <p role="status" className="text-sm">
          {proposal.receipt?.remote ?? 'Planning enregistré.'}
        </p>
      ) : !ready ? (
        <p role="status" className="text-sm text-text-muted">
          {proposal.state === 'dismissed'
            ? 'Proposition refusée. Ton planning est conservé.'
            : 'Cette proposition a expiré. Demande une nouvelle proposition à Chiron.'}
        </p>
      ) : (
        <>
          <p className="text-xs text-text-muted">
            Valable jusqu’au{' '}
            {new Date(proposal.expires_at).toLocaleString('fr-FR', {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
            . Garmin sera vérifié ou exporté séparément.
          </p>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Button strong disabled={action.isPending} onClick={() => action.mutate('apply')}>
                Appliquer les changements
              </Button>
              <Button
                variant="ghost"
                disabled={action.isPending}
                onClick={() => action.mutate('dismiss')}
              >
                Conserver mon planning
              </Button>
            </div>
          )}
        </>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-danger-red">
          {readableError(action.error)}
        </p>
      )}
    </section>
  );
}
