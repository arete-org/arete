import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AretePresence } from '@/components/AreteBrand';
import { Button } from '@/components/ui';
import { tipsApi, type BriefingReaction, type DailyTip } from '@/lib/api';
import { discussWithCoach } from '@/lib/coachToday';
import { parseLocalDate } from '@/lib/dates';
import { frenchClock } from '@/lib/fr';
import { qk } from '@/lib/queryKeys';
import { cn, readableError } from '@/lib/utils';

const REACTIONS: { value: BriefingReaction; emoji: string; label: string }[] = [
  { value: 'up', emoji: '👍', label: 'Utile' },
  { value: 'down', emoji: '👎', label: 'Pas utile' },
];
const MAX_COMMENT_CHARS = 280;

/** "Écrit à 7 h 12 · mis à jour après la synchro de 8 h 05": the text never changes silently. */
function briefingTimes(tip: DailyTip): string | null {
  const written = tip.first_written_at ?? tip.generated_at;
  if (!written) return null;
  const parts = [`Écrit à ${frenchClock(written)}`];
  if (tip.updated_after_sync && tip.generated_at) parts.push(`mis à jour après la synchro de ${frenchClock(tip.generated_at)}`);
  if (tip.source === 'rules') parts.push('calculé à partir de tes métriques');
  return parts.join(' · ');
}

/**
 * 👍/👎 and an optional word, stored on the briefing (idempotent). Each answer
 * is one explicit write: a failure says so and offers a retry, never a replay.
 */
function BriefingReactions({ tip, id, day }: { tip: DailyTip; id: number; day: string }) {
  const client = useQueryClient();
  const [comment, setComment] = useState('');
  const [commenting, setCommenting] = useState(false);
  const save = useMutation({
    mutationFn: (answer: { reaction: BriefingReaction | null; comment?: string }) =>
      tipsApi.react(id, answer.reaction, answer.comment),
    onSuccess: (saved, answer) => {
      client.setQueryData<DailyTip>([...qk.tipDaily, day], (old) =>
        old?.id === saved.id ? { ...old, reaction: saved.reaction, reaction_comment: saved.reaction_comment } : old
      );
      setCommenting(saved.reaction !== null && answer.comment === undefined && !saved.reaction_comment);
      if (answer.comment !== undefined) setComment('');
    },
  });
  const current = tip.reaction ?? null;
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Ton avis sur ce briefing" className="flex items-center gap-2">
        {REACTIONS.map(({ value, emoji, label }) => (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={current === value}
            disabled={save.isPending}
            // Choosing the same answer again withdraws it; changing it keeps the word given.
            onClick={() =>
              save.mutate(
                current === value ? { reaction: null } : { reaction: value, comment: tip.reaction_comment ?? undefined }
              )
            }
            className={cn(
              'min-h-11 min-w-11 rounded-full border text-base transition-colors disabled:opacity-50',
              current === value ? 'border-neon-cyan bg-neon-cyan/15' : 'border-text-muted/25 hover:border-text-muted/50'
            )}
          >
            <span aria-hidden>{emoji}</span>
          </button>
        ))}
        {save.isPending && <span role="status" className="text-xs text-text-muted">Enregistrement…</span>}
      </div>
      {save.error && (
        <p role="alert" className="text-xs text-danger-red">
          Avis non enregistré : {readableError(save.error)}{' '}
          <button type="button" className="text-neon-cyan hover:underline" onClick={() => save.variables && save.mutate(save.variables)}>
            Réessayer
          </button>
        </p>
      )}
      {current && tip.reaction_comment && <p className="text-xs text-text-muted">Ton mot : {tip.reaction_comment}</p>}
      {current && commenting && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (comment.trim()) save.mutate({ reaction: current, comment: comment.trim() });
          }}
        >
          <label className="min-w-0 flex-1 text-xs text-text-muted">
            Un mot pour le coach ? <span className="text-text-muted/80">Facultatif</span>
            <input
              value={comment}
              maxLength={MAX_COMMENT_CHARS}
              onChange={(e) => setComment(e.target.value)}
              className="mt-1 block w-full rounded border border-text-muted/30 bg-abyss px-3 py-2 text-sm text-text-primary"
            />
          </label>
          <Button size="sm" type="submit" disabled={!comment.trim() || save.isPending}>
            Envoyer
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setCommenting(false)}>
            Passer
          </Button>
        </form>
      )}
    </div>
  );
}

/** The previous days, read only when the athlete opens them. */
function BriefingHistory() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: qk.tipHistory,
    queryFn: tipsApi.history,
    staleTime: 5 * 60_000,
  });
  if (isPending) return <p role="status" className="text-xs text-text-muted">Chargement des briefings…</p>;
  if (error)
    return (
      <p role="alert" className="text-xs text-danger-red">
        Briefings indisponibles.{' '}
        <button type="button" className="text-neon-cyan hover:underline" onClick={() => void refetch()}>
          Réessayer
        </button>
      </p>
    );
  if (data.length === 0) return <p className="text-xs text-text-muted">Pas encore de briefing précédent.</p>;
  return (
    <ol className="space-y-3 border-t border-text-muted/15 pt-3">
      {data.map((past) => {
        const reaction = REACTIONS.find((r) => r.value === past.reaction);
        return (
          <li key={past.id} className="space-y-1">
            <p className="text-xs text-text-muted first-letter:uppercase">
              {parseLocalDate(past.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
              {reaction && (
                <span className="ml-2" role="img" aria-label={`Ton avis : ${reaction.label.toLowerCase()}`}>
                  {reaction.emoji}
                </span>
              )}
            </p>
            <p className="text-sm text-text-secondary leading-relaxed">{past.tip}</p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The coach's word for the day, the dashboard's lead: its times (a rewrite by
 * the sync is announced), a reaction, the previous days and a question to the
 * coach, which opens the panel with this briefing selected and the draft kept.
 */
export function BriefingCard({
  tip,
  writing,
  stalled,
  refresh,
  day,
}: {
  tip: DailyTip | undefined;
  writing: boolean;
  stalled: boolean;
  refresh: () => void;
  day: string;
}) {
  const [history, setHistory] = useState(false);
  if (writing)
    return (
      <p className="text-sm font-sans text-text-muted flex items-center gap-2">
        <AretePresence size={24} />
        Le coach écrit ton briefing…
        {stalled && (
          <Button variant="ghost" className="ml-auto" onClick={refresh}>
            Actualiser
          </Button>
        )}
      </p>
    );
  if (!tip?.tip)
    return (
      <p className="text-xs font-sans text-danger-red">
        Briefing indisponible.{' '}
        <button type="button" onClick={refresh} className="text-neon-cyan hover:underline">
          Réessayer
        </button>
      </p>
    );
  const times = briefingTimes(tip);
  const id = tip.id;
  return (
    <div className="space-y-3 font-sans">
      <p className="text-sm text-text-primary leading-relaxed">{tip.tip}</p>
      {times && <p className="text-[11px] text-text-muted">{times}</p>}
      {id != null && <BriefingReactions tip={tip} id={id} day={day} />}
      <div className="flex flex-wrap gap-2">
        {id != null && (
          <Button variant="ghost" size="sm" onClick={() => discussWithCoach({ kind: 'briefing', id })}>
            Demander au coach
          </Button>
        )}
        <Button variant="ghost" size="sm" aria-expanded={history} onClick={() => setHistory((open) => !open)}>
          Briefings précédents
        </Button>
      </div>
      {history && <BriefingHistory />}
    </div>
  );
}
