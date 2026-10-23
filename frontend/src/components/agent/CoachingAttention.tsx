import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
}: {
  enabled?: boolean;
  compact?: boolean;
  home?: boolean;
}) {
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
  return (
    <Panel title={`À suivre avec ${coach.the}`}>
      <div className="space-y-3">
        {unavailable}
        {query.data.items.map((item, index) => (
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
