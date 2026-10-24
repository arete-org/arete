import { GenerationPreview } from '@/components/agent/GenerationPreview';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Loader2, RefreshCw } from 'lucide-react';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { Button, Panel } from '@/components/ui';
import { planApi } from '@/lib/api';
import { parseLocalDate } from '@/lib/dates';
import { invalidateAfterSession, qk } from '@/lib/queryKeys';
import { cn, readableError } from '@/lib/utils';
import type { ReviewProposal, WeeklyReview } from '@/types';

const STALE_TEXT = 'Séance modifiée depuis : proposition ignorée';

/** The server describes a session as « intervals 50 min Z4 »: the type reads in French. */
const sessionLabel = (session: string) => {
  const [kind, ...rest] = session.split(' ');
  return [SESSION_TYPE_LABEL[kind] ?? kind, ...rest].join(' ');
};

const dayLabel = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/** Proposals with a checkbox each; applied ones are checked, locked and marked. */
export function ReviewProposals({
  proposals,
  applied,
  stale,
  selected,
  disabled,
  past = [],
  onToggle,
}: {
  proposals: ReviewProposal[];
  applied: number[];
  stale: number[];
  selected: number[];
  disabled?: boolean;
  /** Proposals for a day already gone: shown, never offered. */
  past?: number[];
  onToggle: (index: number) => void;
}) {
  return (
    <ul className="space-y-2">
      {proposals.map((p) => {
        const done = applied.includes(p.index);
        const gone = !done && past.includes(p.index);
        return (
          <li key={p.index} className={cn('rounded border border-text-muted/20 p-3', (done || gone) && 'opacity-60')}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="accent-neon-cyan mt-1"
                checked={done || (!gone && selected.includes(p.index))}
                disabled={done || gone || disabled}
                onChange={() => onToggle(p.index)}
              />
              <span className="min-w-0 space-y-0.5">
                <span className="block text-xs font-sans text-text-muted">
                  {dayLabel(p.date)} · <span className="text-text-primary">{sessionLabel(p.session)}</span>
                  {done && <span className="ml-2 text-success-green">Appliquée</span>}
                  {gone && <span className="ml-2">Passée</span>}
                </span>
                <span className="block text-sm text-text-secondary">{p.reason}</span>
                {stale.includes(p.index) && (
                  <span className="block text-xs text-warning-orange">{STALE_TEXT}</span>
                )}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function ReviewBody({ review, refreshing }: { review: WeeklyReview; refreshing: boolean }) {
  const queryClient = useQueryClient();
  const [stale, setStale] = useState<number[]>([]);
  // Every proposal still open is ticked until the athlete changes the selection.
  const [picked, setPicked] = useState<number[] | null>(null);
  const open = review.proposals
    .map((p) => p.index)
    .filter((i) => !review.applied.includes(i) && !stale.includes(i));
  const selected = (picked ?? open).filter((i) => open.includes(i));

  const apply = useMutation({
    mutationFn: (indices: number[]) => planApi.applyReview(review.id, indices, review.created_at),
    // Refused (rewritten or answered elsewhere): read the review again.
    onError: () => void queryClient.invalidateQueries({ queryKey: qk.weeklyReview }),
    onSuccess: (result) => {
      setStale((prev) => [...new Set([...prev, ...result.stale])]);
      setPicked(null);
      invalidateAfterSession(queryClient);
      queryClient.invalidateQueries({ queryKey: qk.weeklyReview });
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-sans text-text-muted">
        Semaine du {parseLocalDate(review.week_start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}
        {' · '}
        {review.source === 'agent' ? 'Le coach' : 'Calculé'}
      </p>
      <p className="text-sm text-text-primary whitespace-pre-line leading-relaxed">{review.text}</p>
      {review.proposals.length > 0 && (
        <>
          <ReviewProposals
            proposals={review.proposals}
            applied={review.applied}
            stale={stale}
            selected={selected}
            disabled={apply.isPending || refreshing}
            onToggle={(index) =>
              setPicked(selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index])
            }
          />
          {apply.isError && <p className="text-xs text-danger-red">{readableError(apply.error)}</p>}
          {open.length > 0 && (
            <div className="flex justify-end">
              <Button
                size="sm"
                loading={apply.isPending}
                disabled={selected.length === 0 || refreshing}
                onClick={() => apply.mutate(selected)}
              >
                Appliquer
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The week's review: written on Sunday evening or on demand (the coach may take a minute), applied by choice. */
export function WeeklyReviewPanel() {
  const queryClient = useQueryClient();
  const review = useQuery({ queryKey: qk.weeklyReview, queryFn: planApi.getReview });
  const shownId = review.data?.id ?? null;
  const write = useMutation({
    // « Refaire » names the review on screen: the server rewrites that week, not another.
    mutationFn: (shown: number | null) => (shown === null ? planApi.writeReview(false) : planApi.writeReview(true, shown)),
    onSuccess: (written) => {
      queryClient.setQueryData(qk.weeklyReview, written);
      // « Ma semaine » and the dashboard entry read the same review.
      void queryClient.invalidateQueries({ queryKey: qk.reviewWeek });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard() });
    },
  });

  return (
    <Panel
      className="mb-4 sm:mb-8"
      delay={0.1}
      title={
        <span className="flex items-center gap-2">
          <ClipboardCheck className="size-4 text-neon-purple" /> Bilan de la semaine
        </span>
      }
    >
      {review.isLoading && <p className="text-sm text-text-muted">Chargement du bilan…</p>}
      {review.isError && <p className="text-sm text-danger-red">Bilan indisponible.</p>}
      {write.isPending && <GenerationPreview kind="review" />}
      {write.isPending && (
        <p role="status" className="mb-3 flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="size-4 animate-spin text-neon-purple" />
          Le coach fait le bilan de la semaine passée… cela peut prendre une minute.
        </p>
      )}
      {write.isError && <p className="mb-3 text-xs text-danger-red">{readableError(write.error)}</p>}

      {review.data === null && !write.isPending && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-muted">Pas encore de bilan pour la semaine passée.</p>
          <Button variant="purple" size="sm" onClick={() => write.mutate(null)}>
            Faire le bilan
          </Button>
        </div>
      )}
      {review.data && (
        <>
          {/* A rewrite keeps the id: its version resets the ticks. */}
          <ReviewBody key={`${review.data.id}:${review.data.created_at}`} review={review.data} refreshing={write.isPending} />
          <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
            <Link to="/planning/semaine" className="inline-flex min-h-11 items-center text-sm text-neon-cyan hover:underline">
              Ouvrir Ma semaine <span aria-hidden className="ml-1">→</span>
            </Link>
            <Button variant="ghost" size="sm" disabled={write.isPending} onClick={() => write.mutate(shownId)}>
              <RefreshCw className="size-3.5" /> Refaire le bilan
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
