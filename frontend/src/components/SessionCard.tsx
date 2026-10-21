import { createElement, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, RotateCcw, Trash2, Watch, X } from 'lucide-react';
import { formatClock } from '@/lib/fr';
import type { SessionPush } from '@/lib/workouts';
import { getSportColor, getSportIconComponent } from '@/lib/sport';
import type { PlannedState } from '@/lib/sessionMatch';
import { cn, formatDurationCompact, formatPace } from '@/lib/utils';
import type { ActualSession, PlanDecision, PlannedSession, StrengthSession } from '@/types';
import { DecisionBadge } from './DecisionBadge';
import { GlossaryLink } from './GlossaryLink';
import { Spinner } from './ui/Spinner';

const INTENSITY_LABEL: Record<string, string> = {
  easy: 'facile',
  moderate: 'modérée',
  hard: 'dure',
};
const INTENSITY_TONE: Record<string, string> = {
  easy: 'text-success-green border-success-green/40',
  moderate: 'text-warning-orange border-warning-orange/40',
  hard: 'text-danger-red border-danger-red/40',
};

export const SESSION_TYPE_LABEL: Record<string, string> = {
  endurance: 'Endurance',
  recovery: 'Récupération',
  tempo: 'Seuil',
  intervals: 'Fractionné',
  long_run: 'Sortie longue',
  strength: 'Muscu',
  hypertrophy: 'Muscu',
  power: 'Muscu',
  deload: 'Décharge',
  cross_training: 'Circuit',
  race: 'Course',
};

const STATE_STYLE: Record<PlannedState, string> = {
  done: 'border-success-green/40 bg-success-green/5',
  missed: 'border-danger-red/30 bg-danger-red/5',
  skipped: 'border-text-muted/20 bg-void/40',
  pending: 'border-text-muted/20 bg-shadow/50',
};

export const STATE_LABEL: Record<PlannedState, string> = {
  done: 'Fait',
  missed: 'Manquée',
  skipped: 'Sautée',
  pending: 'Prévu',
};

/** A strength session typed in the Log, shaped like an ActualSession for calendars and lists. */
export function strengthAsActual(s: StrengthSession): ActualSession {
  return {
    id: -s.id, // negative: never collides with actual_sessions ids
    planned_session_id: null,
    date: s.date,
    start_time: null,
    sport: 'strength',
    session_type: 'strength',
    name: s.name ?? `Muscu · ${s.total_sets} séries`,
    duration_sec: (s.duration_min ?? 0) * 60,
    duration_min: '',
    moving_time_sec: null,
    distance_m: null,
    distance_km: null,
    avg_hr: null,
    max_hr: null,
    avg_pace_sec_km: null,
    avg_pace: null,
    ascent_m: null,
    calories: null,
    rpe: s.overall_rpe ?? null,
    notes: s.notes ?? null,
    source: 'strength_log',
    garmin_activity_id: null,
    strava_activity_id: null,
    adherence_score: null,
    exercises: s.exercise_names,
  };
}

/**
 * Realised sessions plus the Muscu logs, each workout once. A log linked to an
 * activity of the list lends it its exercises instead of adding a second entry;
 * the others come in through `strengthAsActual`.
 */
export function withStrengthLogs(actual: ActualSession[], logs: StrengthSession[]): ActualSession[] {
  const linked = new Map(logs.filter((s) => s.garmin_activity_id != null).map((s) => [s.garmin_activity_id, s]));
  const shown = new Set(actual.map((a) => a.id));
  return [
    ...actual.map((a) => {
      const log = linked.get(a.id);
      return log ? { ...a, exercises: log.exercise_names } : a;
    }),
    ...logs.filter((s) => s.garmin_activity_id == null || !shown.has(s.garmin_activity_id)).map(strengthAsActual),
  ];
}

function SportIcon({ sport, className }: { sport: string; className?: string }) {
  return createElement(getSportIconComponent(sport), { className });
}

/** Facts of a realised session: name, duration, distance, pace, HR, RPE. */
export function SessionFacts({ session }: { session: ActualSession }) {
  const km = session.distance_km ?? (session.distance_m ? session.distance_m / 1000 : null);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-sans min-w-0">
      <span className="text-text-primary truncate">{session.name || session.sport}</span>
      {session.duration_sec ? (
        <span className="text-text-secondary">{formatDurationCompact(session.duration_sec)}</span>
      ) : null}
      {km ? <span className="text-text-secondary">{km.toFixed(1)} km</span> : null}
      {session.avg_pace_sec_km ? (
        <span className="text-text-secondary">{formatPace(session.avg_pace_sec_km)}/km</span>
      ) : null}
      {session.avg_hr ? <span className="text-text-secondary">{session.avg_hr} bpm</span> : null}
      {session.ascent_m ? <span className="text-text-secondary">{Math.round(session.ascent_m)} m D+</span> : null}
      {session.rpe ? <span className="text-text-secondary">RPE {session.rpe}</span> : null}
      {session.exercises?.length ? (
        <span className="basis-full text-text-muted truncate">{session.exercises.join(' · ')}</span>
      ) : null}
    </div>
  );
}

/** One line for a realised session with no plan behind it. */
export function OffPlanRow({ session, className }: { session: ActualSession; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-text-muted/15 bg-void/40 px-3 py-1.5',
        className
      )}
    >
      <SportIcon sport={session.sport} className={cn('w-4 h-4 shrink-0', getSportColor(session.sport))} />
      <SessionFacts session={session} />
      <span className="ml-auto shrink-0 text-[11px] font-sans text-warning-orange border border-warning-orange/40 rounded px-1.5">
        hors plan
      </span>
    </div>
  );
}

interface SessionCardProps {
  children?: ReactNode;
  planned: PlannedSession;
  realised: ActualSession | null;
  state: PlannedState;
  onStatus?: (status: 'completed' | 'skipped' | 'pending') => void;
  onDelete?: () => void;
  busy?: boolean;
  /** Today's adaptation of this session, if the morning run decided one. */
  decision?: PlanDecision | null;
  /** Shown for an applied decision other than keep. */
  onRevert?: () => void;
  /** The Garmin line, from the export state; omitted, only a recorded push time shows. */
  push?: SessionPush;
}

function SentLabel({ at }: { at: string | null }) {
  return (
    <span
      className="flex items-center gap-1 text-success-green/80"
      title="La montre la récupère à sa prochaine synchronisation avec le téléphone."
    >
      <Watch className="w-3 h-3" />
      Envoyée à Garmin{at ? ` ${formatClock(at)}` : ''}
    </span>
  );
}

function WatchControl({ push, busy }: { push: SessionPush; busy?: boolean }) {
  switch (push.kind) {
    case 'sent':
      return <SentLabel at={push.at} />;
    case 'unsettled':
      return (
        <>
          <span className="flex items-center gap-1 text-warning-orange">
            <Watch className="w-3 h-3" />
            {push.label}
          </span>
          <Link to={push.href} className="text-neon-cyan hover:underline">
            Vérifier dans le Planning
          </Link>
        </>
      );
    case 'withdraw':
      return (
        <button
          type="button"
          disabled={busy || push.pending}
          onClick={push.onWithdraw}
          title="La séance est sautée mais encore programmée dans Garmin Connect."
          className="flex items-center gap-1 rounded border border-warning-orange/30 bg-warning-orange/10 px-2 py-1 text-warning-orange hover:bg-warning-orange/20 disabled:opacity-40"
        >
          {push.pending ? <Spinner className="w-3 h-3" /> : <Watch className="w-3 h-3" />}
          Retirer de la montre
        </button>
      );
    case 'steps':
      return (
        <Link
          to={push.href}
          title="Les étapes décrites n’ont pas pu être lues : complète-les dans le Planning."
          className="flex items-center gap-1 rounded border border-neon-gold/30 bg-neon-gold/10 px-2 py-1 text-neon-gold hover:bg-neon-gold/20"
        >
          <Watch className="w-3 h-3" />
          Compléter les étapes
        </Link>
      );
    case 'send':
      return (
        <>
          <button
            type="button"
            disabled={busy || push.pending}
            onClick={push.onPush}
            title={push.text ?? undefined}
            className="flex items-center gap-1 rounded border border-neon-cyan/30 bg-neon-cyan/10 px-2 py-1 text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-40"
          >
            {push.pending ? <Spinner className="w-3 h-3" /> : <Watch className="w-3 h-3" />}
            Envoyer sur la montre
          </button>
          {push.text && <span className="text-text-muted">{push.text}</span>}
        </>
      );
  }
}

/**
 * One planned session. Once it is done the realised session takes the front seat
 * and the plan becomes a collapsible reminder underneath.
 */
export function SessionCard({
  children,
  planned,
  realised,
  state,
  onStatus,
  onDelete,
  busy,
  decision,
  onRevert,
  push,
}: SessionCardProps) {
  const [open, setOpen] = useState(false);
  const typeLabel = SESSION_TYPE_LABEL[planned.session_type] ?? planned.session_type;
  const intensity = planned.target_intensity;
  const targets = [
    planned.target_duration_min ? `${planned.target_duration_min} min` : null,
    planned.target_distance_km ? `${planned.target_distance_km} km` : null,
    planned.target_hr_zone,
  ].filter(Boolean);

  return (
    <div className={cn('rounded-lg border px-3 py-2', STATE_STYLE[state])}>
      <div className="flex items-start gap-3">
        <SportIcon
          sport={planned.sport}
          className={cn('w-5 h-5 shrink-0 mt-0.5', state === 'done' ? 'text-success-green' : getSportColor(planned.sport))}
        />

        <div className="min-w-0 flex-1">
          {realised ? (
            <SessionFacts session={realised} />
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-sans">
              <span className="text-text-primary">{typeLabel}</span>
              <span className="text-text-muted capitalize">{planned.sport}</span>
              {targets.map((t) => (
                <span key={t} className="text-text-muted">
                  {t}
                </span>
              ))}
              {intensity && (
                <span className={cn('border rounded px-1.5 py-0.5 text-[11px]', INTENSITY_TONE[intensity])}>
                  {INTENSITY_LABEL[intensity]}
                </span>
              )}
              {planned.status === 'modified' && (
                <span className="border rounded px-1.5 py-0.5 text-[11px] text-neon-gold border-neon-gold/40">
                  modifiée
                </span>
              )}
            </div>
          )}

          {decision && (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] font-sans">
              <DecisionBadge decision={decision.decision} reverted={decision.reverted_at != null} />
              <span className="text-text-secondary">
                {decision.reverted_at ? 'Séance prévue rétablie.' : decision.reason}
              </span>
            </div>
          )}

          {/* Plan reminder: full card when nothing was done, one collapsible line otherwise */}
          {realised ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-1 flex items-center gap-1 text-[11px] font-sans text-text-muted hover:text-text-secondary"
            >
              <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
              Prévu : {typeLabel}
              {targets.length > 0 && ` · ${targets.join(' · ')}`}
            </button>
          ) : null}
          {planned.description && (!realised || open) && (
            <p className="mt-1 text-xs font-sans text-text-secondary whitespace-pre-line">{planned.description}</p>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {state === 'done' && <><Check aria-hidden="true" className="w-4 h-4 text-success-green" /><span className="sr-only">{STATE_LABEL.done}</span></>}
          {state !== 'done' && state !== 'pending' && (
            <span className="text-[11px] font-sans text-text-muted">{STATE_LABEL[state]}</span>
          )}
          {onStatus && state !== 'done' && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStatus('completed')}
                title="Marquer comme faite (sans montre)"
                aria-label="Marquer comme faite (sans montre)"
                className="p-1 rounded text-text-muted hover:text-success-green hover:bg-success-green/10 disabled:opacity-40"
              >
                <Check aria-hidden="true" className="w-4 h-4" />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStatus(state === 'skipped' ? 'pending' : 'skipped')}
                title={state === 'skipped' ? 'Remettre en attente' : 'Marquer comme sautée'}
                aria-label={state === 'skipped' ? 'Remettre en attente' : 'Marquer comme sautée'}
                className="p-1 rounded text-text-muted hover:text-warning-orange hover:bg-warning-orange/10 disabled:opacity-40"
              >
                <X aria-hidden="true" className="w-4 h-4" />
              </button>
            </>
          )}
          {onDelete && (
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              title="Supprimer la séance planifiée"
              aria-label="Supprimer la séance planifiée"
              className="p-1 rounded text-text-muted hover:text-danger-red hover:bg-danger-red/10 disabled:opacity-40"
            >
              <Trash2 aria-hidden="true" className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {!realised && (planned.garmin_pushed_at || push || canRevert(decision, onRevert)) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-sans">
          {push ? (
            <WatchControl push={push} busy={busy} />
          ) : (
            planned.garmin_pushed_at && <SentLabel at={planned.garmin_pushed_at} />
          )}
          {canRevert(decision, onRevert) && (
            <button
              type="button"
              disabled={busy}
              onClick={onRevert}
              className="flex items-center gap-1 text-text-muted hover:text-text-primary disabled:opacity-40"
            >
              <RotateCcw className="w-3 h-3" />
              Rétablir la séance prévue
            </button>
          )}
          {push && 'error' in push && push.error && (
            <span className="basis-full text-danger-red">{push.error}</span>
          )}
        </div>
      )}

      {state === 'done' && realised?.adherence_score != null && (
        <div className="mt-1 flex items-center gap-1 text-[11px] font-sans text-success-green/80">
          Adhérence {Math.round(realised.adherence_score)} %
          <GlossaryLink term="adherence" />
        </div>
      )}
      {children}
    </div>
  );
}

/** An applied decision that changed the session can be undone, once. */
function canRevert(decision: PlanDecision | null | undefined, onRevert: (() => void) | undefined): boolean {
  return Boolean(onRevert && decision && decision.decision !== 'keep' && !decision.reverted_at);
}
