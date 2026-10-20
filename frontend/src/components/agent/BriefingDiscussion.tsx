import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tipsApi, type PastBriefing, type BriefingReaction } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { parseLocalDate } from '@/lib/dates';
import { frenchClock } from '@/lib/fr';
import { readableError } from '@/lib/utils';
import { FeedbackRating } from './FeedbackRating';
import { AgentMarkdown } from './AgentMarkdown';
import { useCoachName } from '@/lib/coachName';

/** The stored briefing is context, never a fabricated assistant turn or trace. */
export function BriefingDiscussion({ id }: { id: number }) {
  const client = useQueryClient();
  const coach = useCoachName();
  const key = ['briefing', id] as const;
  const query = useQuery({ queryKey: key, queryFn: () => tipsApi.briefing(id), retry: false });
  const save = useMutation({
    retry: false,
    mutationFn: (reaction: BriefingReaction | null) => tipsApi.react(id, reaction, reaction ? query.data?.reaction_comment ?? undefined : undefined),
    onSuccess: saved => {
      client.setQueryData<PastBriefing>(key, old => old ? { ...old, ...saved } : old);
      void client.invalidateQueries({ queryKey: qk.tipDaily });
      void client.invalidateQueries({ queryKey: qk.tipHistory });
    },
  });
  if (query.isPending) return <p role="status" className="text-sm text-text-muted">Chargement du briefing…</p>;
  if (query.isError) return <div role="alert" className="text-sm text-danger-red">
    <p>Briefing indisponible : {readableError(query.error)}</p>
    <button type="button" className="min-h-11 underline" onClick={() => void query.refetch()}>Réessayer</button>
  </div>;
  const briefing = query.data;
  return <section aria-label="Briefing dans cette conversation" className="mb-5 space-y-3">
    <div>
      <h3 className="text-sm font-medium text-text-primary">Briefing du {parseLocalDate(briefing.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</h3>
      <p className="mt-1 text-xs text-text-muted">{briefing.source === 'rules' ? 'Calculé à partir de tes métriques' : `Par ${coach}`}{briefing.generated_at ? ` · ${frenchClock(briefing.generated_at)}` : ''}</p>
    </div>
    <AgentMarkdown text={briefing.tip} />
    <div role="group" aria-label="Ton avis sur ce briefing" className="flex items-center gap-0.5">
      <FeedbackRating value={briefing.reaction === 'up' ? 1 : briefing.reaction === 'down' ? 0 : null}
        labels={['Briefing utile', 'Briefing peu utile']} disabled={save.isPending || save.isError}
        onChange={score => save.mutate(score === null ? null : score === 1 ? 'up' : 'down')} />
      <span role="status" className="text-xs text-text-muted">{save.isPending ? 'Enregistrement…' : save.isSuccess ? 'Enregistré' : ''}</span>
    </div>
    {briefing.reaction_comment && <p className="text-xs text-text-muted">Ton avis précédent : {briefing.reaction_comment}</p>}
    {save.error && <p role="alert" className="text-xs text-danger-red">Avis non confirmé : {readableError(save.error)} <button type="button" className="min-h-11 underline" onClick={() => void query.refetch().then(result => { if (result.isSuccess) save.reset(); })}>Vérifier l’avis enregistré</button></p>}
    <p className="border-t border-text-muted/15 pt-3 text-xs text-text-muted">Ce briefing accompagne tes messages dans ce fil.</p>
  </section>;
}
