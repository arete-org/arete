import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { AreteMark } from '@/components/AreteBrand';
import { Button, Panel } from '@/components/ui';
import { attentionKey, useCoachingAttention } from '@/hooks/useCoachingAttention';
import { coachApi, coachTodayKey } from '@/lib/coachToday';
import { readableError } from '@/lib/utils';
import { InboxPriority } from '@/components/AutomationInbox';
import { CoachTodayPanel } from './CoachToday';
import { useCoachWords } from '@/lib/coachName';

/** Source cards remain usable when coordination is observing or unavailable. */
export function CoachingAttention({
  enabled = true,
  compact = false,
  home = false,
  hero = false,
}: {
  enabled?: boolean;
  compact?: boolean;
  home?: boolean;
  hero?: boolean;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const query = useCoachingAttention(enabled);
  const coach = useCoachWords();
  const prepare = useMutation({
    mutationFn: coachApi.prepare,
    onSuccess: async (data) => {
      client.setQueryData(coachTodayKey, data);
      await client.invalidateQueries({ queryKey: attentionKey });
    },
  });
  const unavailable = query.isError ? (
    <p role="alert" className="text-xs text-danger-red">
      Priorités {coach.of} indisponibles.{' '}
      <button className="min-h-11 underline" onClick={() => void query.refetch()}>
        Réessayer
      </button>
    </p>
  ) : null;
  if (!query.data?.enabled) {
    return compact ? (
      unavailable
    ) : (
      <>
        <CoachTodayPanel enabled={enabled} refetchOnFocus={false} home={home} />
        {!home && <InboxPriority />}
        {unavailable}
      </>
    );
  }
  if (home) {
    const actions = query.data.items.filter(item => item.kind !== 'recap');
    const first = actions[0];
    const remaining = actions.length + query.data.remaining - (first ? 1 : 0);
    return <section aria-label="À suivre avec le coach" className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{first ? (first.kind === 'approval' ? 'Une proposition à examiner' : 'Ton retour est attendu') : 'Aucune réponse attendue'}</p>
        <p className="mt-1 text-sm text-text-secondary">{first?.title ?? 'Retrouve tes bilans et les points précédents dans le suivi.'}</p>
        {remaining > 0 && <p className="mt-1 text-xs text-text-muted">{remaining} autre(s) point(s) dans le suivi.</p>}
      </div>
      <Link to={first?.url ?? '/follow-up'} data-variant="outline" className="ui-button inline-flex min-h-11 items-center rounded border border-text-muted/30 px-4 py-2 text-sm">{first ? 'Examiner' : 'Voir le suivi'}</Link>
      {unavailable}
    </section>;
  }
  if (hero && query.data.items.length === 0) return unavailable;
  const [primary, ...following] = query.data.items;
  return (
    <Panel title={hero ? undefined : `À suivre avec ${coach.the}`} className={hero ? 'bg-surface-raised' : undefined}>
      <div className="space-y-3">
        {unavailable}
        {hero && primary && <section aria-label="Ta priorité avec le coach" className="space-y-3">
          <p className="flex items-center gap-2 text-xs text-ink-secondary"><AreteMark size={20} />Avec {coach.the} aujourd’hui</p>
          <h2 className="font-display text-3xl font-semibold text-ink-primary">{primary.title}</h2>
          <p className="text-sm text-ink-secondary">{primary.kind === 'approval' ? 'Une proposition attend ton accord avant de modifier le planning.' : primary.kind === 'question' ? 'Ton retour permet de préparer la suite de ton entraînement.' : 'Prends un moment pour relire ta progression et préparer la suite.'}</p>
          <Button strong onClick={() => navigate(primary.url)}>{primary.kind === 'approval' ? 'Examiner la proposition' : primary.kind === 'question' ? 'Répondre au coach' : 'Lire le bilan'}</Button>
        </section>}
        {(hero ? following : query.data.items).map((item, index) => (
          <Link
            key={item.subject_key}
            to={item.url}
            className={`block rounded-[var(--radius-control)] border p-4 ${index === 0 ? 'border-neon-cyan/30 bg-neon-cyan/5' : 'border-border'}`}
          >
            <p className="text-xs text-text-muted">
              {item.kind === 'approval'
                ? 'À décider'
                : item.kind === 'question'
                  ? 'Ton retour'
                  : 'Ton bilan'}
            </p>
            <p className="mt-1 text-sm font-medium">{item.title}</p>
            <span className="mt-2 inline-block text-xs text-neon-cyan">
              {item.kind === 'approval'
                ? 'Examiner la proposition'
                : item.kind === 'question'
                  ? 'Ouvrir le suivi'
                  : 'Lire le bilan'}{' '}
              ↗
            </span>
          </Link>
        ))}
        {query.data.items.length === 0 && (
          <p className="text-sm text-text-muted">
            Le suivi est à jour. {coach.The} reste disponible quand tu en as besoin.
          </p>
        )}
        {query.data.remaining > 0 && (
          <p className="text-xs text-text-muted">
            {query.data.remaining} autre(s) suivi(s) après ces priorités.
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={prepare.isPending}
          onClick={() => prepare.mutate()}
        >
          {prepare.isPending ? 'Actualisation…' : 'Actualiser le suivi'}
        </Button>
        {prepare.error && (
          <p role="alert" className="text-xs text-danger-red">
            {readableError(prepare.error)}
          </p>
        )}
      </div>
    </Panel>
  );
}
