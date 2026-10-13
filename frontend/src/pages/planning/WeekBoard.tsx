import type { ComponentProps, ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui';
import { WorkoutCard } from '@/components/WorkoutCard';
import { formatDurationCompact, cn } from '@/lib/utils';
import { parseLocalDate } from '@/lib/dates';
import { exportLabel } from '@/lib/workouts';
import { linkDay, type PlannedState } from '@/lib/sessionMatch';
import type { ActualSession, PlannedSession } from '@/types';
import { dayLabel, sessionTitle, sessionSummary, sportLabel, STATE_LABELS } from './sessionForm';

export function GarminState({
  state,
  unavailable = false,
}: {
  state: ComponentProps<typeof WorkoutCard>['initial'];
  unavailable?: boolean;
}) {
  const value = state?.export;
  const warning = ['uncertain', 'conflict', 'dirty', 'failed', 'pending_removal'].includes(
    value?.state ?? '',
  );
  const success = ['scheduled', 'transfer_requested', 'removed'].includes(value?.state ?? '');
  return (
    <span
      className={cn(
        'block text-[11px] leading-relaxed',
        warning ? 'text-warning-orange' : success ? 'text-success-green' : 'text-text-muted',
      )}
    >
      {unavailable ? 'État Garmin indisponible' : exportLabel(value ?? null)}
    </span>
  );
}

export function PlanningSessionCard({
  planned,
  state,
  realised,
  workout,
  active,
  selecting,
  exportUnavailable,
  onActivate,
  onOpen,
  onDrag,
}: {
  planned: PlannedSession;
  state: PlannedState;
  realised: ActualSession | null;
  workout: ComponentProps<typeof WorkoutCard>;
  active: boolean;
  selecting: boolean;
  exportUnavailable: boolean;
  onActivate: () => void;
  onOpen: () => void;
  onDrag: (session: PlannedSession | null) => void;
}) {
  const current = workout.initial?.session;
  const blocked =
    workout.locked ||
    exportUnavailable ||
    ['working', 'uncertain', 'conflict'].includes(workout.initial?.export?.state ?? '');
  const title = sessionTitle(planned);
  const [metric, recovery] = sessionSummary(planned).split(' · récup. ');
  return (
    <>
      <article
        className={cn('planning-session', active && 'planning-session-active')}
        data-testid={`workout-${planned.id}`}
        draggable={!blocked && state !== 'done'}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(planned.id));
          onDrag(planned);
        }}
        onDragEnd={() => onDrag(null)}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-neon-cyan">
            {sportLabel(planned.sport)}
          </span>
          {selecting && (
            <label className="flex min-h-11 min-w-11 items-center justify-center -my-2 -mr-2">
              <input
                type="checkbox"
                className="size-4 accent-neon-cyan"
                aria-label={`Sélectionner ${title}`}
                checked={workout.selected}
                disabled={blocked || state !== 'pending' || current?.exportable === false}
                onChange={(e) => {
                  if (current) workout.onSelect?.(current, e.target.checked);
                }}
              />
            </label>
          )}
        </div>
        <button
          type="button"
          aria-pressed={active}
          className="planning-card-title block w-full text-left font-semibold text-base leading-snug break-words"
          onClick={onActivate}
          onDoubleClick={onOpen}
        >
          {title}
        </button>
        <button
          type="button"
          className="planning-card-open text-left font-semibold text-base leading-snug"
          aria-label={`Ouvrir la séance ${title}`}
          onClick={onOpen}
        >
          <span className="min-w-0 break-words">{title}</span>
        </button>
        <p className="text-[13px] text-text-secondary">{metric}</p>
        {recovery && <p className="text-[11px] text-text-muted">Récupération {recovery}</p>}
        {realised && (
          <p className="text-xs text-text-secondary">
            {formatDurationCompact(realised.duration_sec)}
            {realised.distance_m ? ` · ${(realised.distance_m / 1000).toFixed(1)} km` : ''} réalisés
          </p>
        )}
        {realised?.exercises?.length ? (
          <p className="text-[11px] text-text-muted break-words">{realised.exercises.join(' · ')}</p>
        ) : null}
        <p
          className={cn(
            'text-[11px] font-medium',
            state === 'done'
              ? 'text-success-green'
              : state === 'missed'
                ? 'text-danger-red'
                : 'text-text-muted',
          )}
        >
          {state === 'done' ? '✓ ' : ''}
          {STATE_LABELS[state]}
        </p>
        <GarminState state={workout.initial} unavailable={exportUnavailable} />
      </article>
      <Button strong className="planning-card-cta" onClick={onOpen}>
        Ouvrir la séance
      </Button>
    </>
  );
}

export function WeekBoard({
  days,
  planned,
  actual,
  today,
  selectedDate,
  restDays,
  sport,
  render,
  summary,
  onDay,
  onCreate,
  onDropSession,
}: {
  days: string[];
  planned: PlannedSession[];
  actual: ActualSession[];
  today: string;
  selectedDate: string;
  restDays: string[];
  sport: string;
  summary: ReactNode;
  render: (id: number) => ReactNode;
  onDay: (date: string) => void;
  onCreate: (date: string) => void;
  onDropSession: (date: string) => void;
}) {
  return (
    <>
      <div className="planning-day-strip" role="group" aria-label="Jours de la semaine">
        {days.map((date) => (
          <button
            key={date}
            type="button"
            aria-pressed={date === selectedDate}
            aria-current={date === today ? 'date' : undefined}
            aria-label={dayLabel(date)}
            onClick={() => onDay(date)}
          >
            <span className="text-[13px] font-medium">
              {parseLocalDate(date).toLocaleDateString('fr-FR', {
                weekday: 'narrow',
              })}
            </span>
            <span className="text-[17px] font-semibold tabular-nums">
              {parseLocalDate(date).getDate()}
            </span>
            <span aria-hidden="true" className="text-xs">
              {planned.some((s) => s.date === date) ? '•' : '–'}
            </span>
          </button>
        ))}
      </div>
      <div className="planning-mobile-summary">{summary}</div>
      <div className="planning-week-board" aria-label="Séances de la semaine">
        {days.map((date) => {
          const link = linkDay(
            date,
            planned.filter((s) => s.date === date),
            actual,
            today,
          );
          const sessions = link.planned.filter((s) => !sport || s.session.sport === sport);
          const offPlan = link.offPlan.filter((s) => !sport || s.sport === sport);
          const rest = restDays.includes(
            parseLocalDate(date).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase(),
          );
          const empty = !sessions.length && !offPlan.length;
          return (
            <section
              key={date}
              className={cn('planning-day', date === selectedDate && 'planning-day-selected')}
              aria-label={dayLabel(date)}
              data-date={date}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDropSession(date);
              }}
            >
              <header className="planning-mobile-day-heading">
                <h3 className="text-[15px] font-semibold">
                  {parseLocalDate(date).toLocaleDateString('fr-FR', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                </h3>
                <Button
                  variant="ghost"
                  onClick={() => onCreate(date)}
                  aria-label={`Ajouter une séance le ${dayLabel(date)}`}
                >
                  <Plus className="size-4" />
                  Ajouter
                </Button>
              </header>
              <header className="planning-day-heading">
                <h3 className="text-[13px] uppercase font-semibold text-text-muted">
                  {parseLocalDate(date).toLocaleDateString('fr-FR', {
                    weekday: 'long',
                  })}
                </h3>
                <span
                  className={cn(
                    'text-2xl font-semibold tabular-nums',
                    date === today && 'text-neon-cyan',
                  )}
                >
                  {parseLocalDate(date).getDate()}
                </span>
              </header>
              {sessions.map(({ session }) => (
                <div key={session.id}>{render(session.id)}</div>
              ))}
              {offPlan.map((session) => (
                <Link
                  className="planning-session text-sm"
                  key={session.id}
                  to={session.id < 0 ? '/log' : `/log/sessions/${session.id}`}
                >
                  <span className="text-xs text-warning-orange">Hors plan</span>
                  <span className="font-semibold break-words">
                    {session.name || sportLabel(session.sport)}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {formatDurationCompact(session.duration_sec)}
                  </span>
                </Link>
              ))}
              {empty && (
                <div className="planning-session">
                  <p className="text-sm font-medium text-text-secondary">
                    {sport && link.planned.length
                      ? 'Aucune séance pour ce sport'
                      : rest
                        ? 'Repos prévu'
                        : 'Journée libre'}
                  </p>
                  <p className="text-xs text-text-muted">
                    {rest ? 'Du temps pour récupérer.' : 'Votre planning reste ouvert.'}
                  </p>
                </div>
              )}
              <Button
                variant="ghost"
                className="planning-day-add justify-start text-neon-cyan"
                onClick={() => onCreate(date)}
                aria-label={`Ajouter une séance le ${dayLabel(date)}`}
              >
                <Plus className="size-4" />
                Ajouter
              </Button>
            </section>
          );
        })}
      </div>
    </>
  );
}
