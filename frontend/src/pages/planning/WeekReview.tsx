import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { AdherenceBar } from '@/components/AdherenceBar';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { Button, Panel, Skeleton } from '@/components/ui';
import { planApi } from '@/lib/api';
import { discussWithCoach } from '@/lib/coachToday';
import { parseLocalDate } from '@/lib/dates';
import { formatDecimal, formatHoursMinutes } from '@/lib/fr';
import { invalidateAfterSession, qk } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';
import type { ReviewAccepted, ReviewWeek, WeekPushSession, WeekRecap, WeeklyReview } from '@/types';
import { ReviewProposals } from './WeeklyReviewPanel';

const dayMonth = (iso: string) => parseLocalDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
const shortDay = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const minutes = (value: number) => formatHoursMinutes(value * 60);

/** What the server says it did with each key session (no inference here). */
const GARMIN_OUTCOME: Record<WeekPushSession['outcome'], string> = {
  sent: 'envoyée sur Garmin Connect',
  already: 'déjà sur Garmin, inchangée',
  withdrawn: 'retirée de Garmin',
  skipped: 'non envoyée (envoi en cours ou séance non exportable)',
  failed: 'échec de l’envoi, réessaie depuis le planning',
  not_started: 'non envoyée (limite de l’envoi atteinte)',
};
const GARMIN_STATE: Record<Exclude<ReviewAccepted['garmin']['state'], 'done'>, string> = {
  disabled: 'Montre : envoi automatique désactivé (Réglages › Coach).',
  disconnected: 'Montre : Garmin n’est pas connecté.',
  failed: 'Montre : l’envoi n’a pas pu démarrer, réessaie depuis le planning.',
};
const CALENDAR: Record<string, string> = {
  synced: 'Calendrier : à jour.',
  partial: 'Calendrier : synchronisation partielle, la suite au prochain passage.',
  busy: 'Calendrier : une synchronisation est déjà en cours, elle inclura ces changements.',
  failed: 'Calendrier : échec de la synchronisation (détail dans Réglages › Connexions).',
};

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="ui-inset min-w-0 p-3">
      <p className="text-[11px] font-sans uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-sans font-semibold tabular-nums text-text-primary">{value}</p>
      {detail && <p className="mt-0.5 text-[11px] font-sans text-text-muted">{detail}</p>}
    </div>
  );
}

/** Last week in four numbers, then the coach's words. */
function Recap({ recap, review }: { recap: WeekRecap; review: WeeklyReview }) {
  const adherence = recap.adherence == null ? null : Math.round(recap.adherence * 100);
  return (
    <Panel title={`Semaine du ${dayMonth(recap.week_start)} au ${dayMonth(recap.week_end)}`}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Séances" value={`${recap.completed}/${recap.planned}`} detail="faites / prévues" />
        <Tile
          label="Volume"
          value={minutes(recap.minutes_done)}
          detail={`sur ${minutes(recap.minutes_planned)} prévues`}
        />
        <div className="ui-inset min-w-0 p-3">
          <p className="text-[11px] font-sans uppercase tracking-wide text-text-muted">Régularité</p>
          <p className="mt-1 text-xl font-sans font-semibold tabular-nums text-text-primary">
            {adherence == null ? '—' : `${adherence} %`}
          </p>
          {adherence != null && (
            <div className="mt-1.5">
              <AdherenceBar score={adherence} showLabel={false} size="sm" />
            </div>
          )}
        </div>
        <Tile
          label="Forme"
          value={recap.tsb == null ? '—' : formatDecimal(recap.tsb, 0, true)}
          detail="TSB, forme de fond moins fatigue"
        />
      </div>
      <figure className="mt-4">
        <figcaption className="text-[11px] font-sans text-text-muted">
          {review.source === 'agent' ? 'Le mot du coach' : 'Le bilan calculé'}
        </figcaption>
        <blockquote className="mt-1 whitespace-pre-line text-sm leading-relaxed text-text-primary">
          {review.text}
        </blockquote>
      </figure>
    </Panel>
  );
}

function Outcome({ result, review }: { result: ReviewAccepted; review: WeeklyReview }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The accept button may leave with the last open proposal: the focus comes here, not to the page.
  useEffect(() => heading.current?.focus({ preventScroll: false }), [result]);
  const label = (s: WeekPushSession) =>
    `${shortDay(s.date)} · ${SESSION_TYPE_LABEL[s.session_type] ?? s.session_type}`;
  const applied = result.applied.length;
  return (
    <section role="status" aria-labelledby="week-outcome" className="ui-inset space-y-1.5 p-4 text-sm">
      <h2 id="week-outcome" ref={heading} tabIndex={-1} className="font-semibold text-text-primary outline-none">
        Semaine acceptée
      </h2>
      <p className="text-text-secondary">
        {applied === 0
          ? 'Aucune proposition appliquée : le planning reste tel quel.'
          : `${applied} proposition${applied > 1 ? 's' : ''} appliquée${applied > 1 ? 's' : ''} au planning.`}
      </p>
      {result.stale.length > 0 && (
        <p className="text-warning-orange">
          {result.stale.length} proposition{result.stale.length > 1 ? 's' : ''} ignorée
          {result.stale.length > 1 ? 's' : ''} : la séance a changé depuis le bilan.
        </p>
      )}
      {result.garmin.state === 'done' ? (
        result.garmin.sessions.length === 0 ? (
          <p className="text-text-secondary">Montre : aucune séance clé à envoyer.</p>
        ) : (
          <ul className="space-y-0.5" aria-label="Séances clés sur la montre">
            {result.garmin.sessions.map((s) => (
              <li
                key={s.planned_session_id}
                className={s.outcome === 'failed' ? 'text-danger-red' : 'text-text-secondary'}
              >
                {label(s)} : {GARMIN_OUTCOME[s.outcome]}
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className={result.garmin.state === 'failed' ? 'text-danger-red' : 'text-text-secondary'}>
          {GARMIN_STATE[result.garmin.state]}
        </p>
      )}
      {CALENDAR[result.calendar] && <p className="text-text-secondary">{CALENDAR[result.calendar]}</p>}
      {review.proposals.length > 0 && applied > 0 && (
        <Link to="/planning" className="inline-flex min-h-11 items-center text-neon-cyan hover:underline">
          Voir le planning <span aria-hidden className="ml-1">→</span>
        </Link>
      )}
    </section>
  );
}

function Proposals({ week, review }: { week: ReviewWeek; review: WeeklyReview }) {
  const client = useQueryClient();
  const [result, setResult] = useState<ReviewAccepted | null>(null);
  const [stale, setStale] = useState<number[]>([]);
  const [picked, setPicked] = useState<number[] | null>(null);
  // Every proposal still open is ticked until the athlete changes the selection.
  const open = review.proposals
    .filter((p) => p.date > week.today)
    .map((p) => p.index)
    .filter((i) => !review.applied.includes(i) && !stale.includes(i));
  const selected = (picked ?? open).filter((i) => open.includes(i));

  const accept = useMutation({
    mutationFn: (indices: number[]) => planApi.acceptReview(review.id, indices),
    onSuccess: async (accepted) => {
      setResult(accepted);
      setStale((prev) => [...new Set([...prev, ...accepted.stale])]);
      setPicked(null);
      // A read in flight predates the answer: it must not land after it.
      await client.cancelQueries({ queryKey: qk.reviewWeek });
      client.setQueryData<ReviewWeek>(qk.reviewWeek, (current) =>
        current?.review?.id === review.id
          ? {
              ...current,
              review: {
                ...current.review,
                applied: [...new Set([...current.review.applied, ...accepted.applied])],
                applied_at: current.review.applied_at ?? new Date().toISOString(),
              },
            }
          : current,
      );
      void client.invalidateQueries({ queryKey: qk.weeklyReview });
      invalidateAfterSession(client);
    },
  });
  const answered = review.applied_at !== null;

  return (
    <Panel title="Pour la semaine qui vient">
      <div className="space-y-4">
        {review.proposals.length > 0 ? (
          <ReviewProposals
            proposals={review.proposals}
            applied={review.applied}
            stale={stale}
            selected={selected}
            disabled={accept.isPending}
            onToggle={(index) =>
              setPicked(selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index])
            }
          />
        ) : (
          <p className="text-sm text-text-secondary">Rien à changer : la semaine prévue tient.</p>
        )}
        {accept.isError && (
          <p role="alert" className="text-sm text-danger-red">
            {readableError(accept.error)}
          </p>
        )}
        {result && <Outcome result={result} review={review} />}
        {answered && !result && (
          <p className="text-sm text-text-secondary">Semaine déjà acceptée.</p>
        )}
        {(!answered || open.length > 0) && !result && (
          <p className="text-xs text-text-muted">
            « Accepter » applique {review.proposals.length > 0 ? 'les propositions cochées' : 'la semaine'}, puis
            envoie les séances clés sur ta montre et ton calendrier.
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => discussWithCoach({ kind: 'review', id: review.id })}
          >
            <MessageCircle className="size-4" /> Ajuster avec le coach
          </Button>
          {(!answered || open.length > 0) && !(result && open.length === 0) && (
            <Button strong loading={accept.isPending} onClick={() => accept.mutate(selected)}>
              {selected.length > 0 ? `Accepter (${selected.length})` : 'Accepter'}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Nothing written yet for the week: the coach writes it on Sunday evening. */
function NoReview() {
  const client = useQueryClient();
  const write = useMutation({
    mutationFn: () => planApi.writeReview(false),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.weeklyReview }),
  });
  return (
    <Panel>
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          Pas encore de bilan : le coach l’écrit dimanche soir et te prévient.
        </p>
        {write.isError && <p className="text-xs text-danger-red">{readableError(write.error)}</p>}
        <Button variant="purple" loading={write.isPending} onClick={() => write.mutate()}>
          Faire le bilan maintenant
        </Button>
      </div>
    </Panel>
  );
}

/** « Ma semaine »: last week in four numbers and the coach's words, then next week's proposals. */
export function WeekReviewPage() {
  const week = useQuery({ queryKey: qk.reviewWeek, queryFn: planApi.getReviewWeek });
  return (
    <div className="page-shell bg-void">
      <div className="page-content mx-auto max-w-3xl space-y-4">
        <header>
          <Link
            to="/planning"
            className="-ml-1 inline-flex min-h-11 items-center gap-1 text-sm font-sans text-text-muted hover:text-text-primary"
          >
            <ArrowLeft className="size-4" aria-hidden /> Planning
          </Link>
          <h1 className="page-title">Ma semaine</h1>
          <p className="mt-1 text-xs font-sans text-text-muted">Le bilan de la semaine passée, et ce que le coach propose.</p>
        </header>
        {week.isPending ? (
          <Panel>
            <Skeleton label="Chargement du bilan" lines={4} />
          </Panel>
        ) : week.isError ? (
          <Panel>
            <p className="text-sm text-danger-red">
              Bilan indisponible.{' '}
              <button type="button" className="min-h-11 text-neon-cyan hover:underline" onClick={() => void week.refetch()}>
                Réessayer
              </button>
            </p>
          </Panel>
        ) : week.data.review && week.data.recap ? (
          <>
            <Recap recap={week.data.recap} review={week.data.review} />
            <Proposals key={week.data.review.id} week={week.data} review={week.data.review} />
          </>
        ) : (
          <NoReview />
        )}
      </div>
    </div>
  );
}
