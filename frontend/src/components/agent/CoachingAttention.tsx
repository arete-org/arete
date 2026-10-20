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
}: {
  enabled?: boolean;
  compact?: boolean;
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
        <CoachTodayPanel enabled={enabled} refetchOnFocus={false} />
        <InboxPriority />
        {unavailable}
      </>
    );
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
