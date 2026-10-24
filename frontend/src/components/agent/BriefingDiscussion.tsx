import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tipsApi, type PastBriefing, type BriefingReaction } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { parseLocalDate } from '@/lib/dates';
import { frenchClock } from '@/lib/fr';
import { readableError } from '@/lib/utils';
import { FeedbackRating } from './FeedbackRating';
import { AgentMarkdown } from './AgentMarkdown';
import { useCoachWords } from '@/lib/coachName';

/** The stored briefing is context, never a fabricated assistant turn or trace. */
export function BriefingDiscussion({ id }: { id: number }) {
  const client = useQueryClient();
  const coach = useCoachWords();
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
  return <section aria-label="Briefing dans cette conversation" className="briefing-discussion mb-6 space-y-5">
    <div>
      <h3 className="font-display text-[2rem] leading-tight text-text-primary">Briefing du {parseLocalDate(briefing.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</h3>
      <p className="mt-1 text-xs text-text-muted">{briefing.source === 'rules' ? 'Calculé à partir de tes métriques' : `Par ${coach.the}`}{briefing.generated_at ? ` · ${frenchClock(briefing.generated_at)}` : ''}</p>
    </div>
    <div className="briefing-copy"><AgentMarkdown text={briefing.tip} /></div>
    <div className="rounded-[var(--radius-control)] border border-border bg-shadow/30 p-4">
      <h4 className="mb-3 text-sm font-medium">Repères au moment du briefing</h4>
      {briefing.evidence?.length ? <dl className="space-y-3">
        {briefing.evidence.map(fact => <div key={fact.label} className="flex items-start justify-between gap-4">
          <dt className="min-w-0"><span className="block text-sm text-text-secondary">{fact.label}</span><span className="mt-0.5 block text-xs text-text-muted">{fact.source} · {parseLocalDate(fact.measured_on).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</span></dt>
          <dd className="shrink-0 text-sm font-medium tabular-nums">{fact.value}</dd>
        </div>)}
      </dl> : <p className="text-xs leading-relaxed text-text-muted">Aucune mesure source conservée pour ce briefing.</p>}
    </div>
    <div role="group" aria-label="Ton avis sur ce briefing" className="flex flex-wrap items-center gap-1 border-t border-border pt-3">
      <span className="mr-auto text-sm text-text-secondary">Ce conseil t’aide ?</span>
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
