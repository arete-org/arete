import { Link } from 'react-router-dom';
import { Flag } from 'lucide-react';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { parseLocalDate } from '@/lib/dates';
import { formBand, plannedUntil, planReachesRaceWeek, useFormCurve, useInView } from '@/lib/formCurve';
import { goalKind, longDate } from '@/lib/race';
import type { Goal } from '@/types';

const shortDay = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The race the athlete trains for, leading the dashboard: J-x, the form
 * projected on race day and the week's key session, both from the curve's
 * lazy read. The band shows only when the plan reaches race week: before
 * that the projection is mostly assumed rest, and the card says so. Without
 * a race ahead, a compact call to set one (a race already run only comes
 * from yesterday's cached answer: the server never sends one).
 */
export function GoalCard({ goal, day, ready }: { goal: Goal | null; day: string | undefined; ready: boolean }) {
  const [ref, visible] = useInView();
  const ahead = goal != null && goal.days_left >= 0;
  const curve = useFormCurve(day, ready && ahead && visible);
  if (!ahead)
    return (
      <div className="glass-panel flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm font-sans">
        <span className="flex items-center gap-2 text-text-muted">
          <Flag className="w-4 h-4 text-neon-gold shrink-0" aria-hidden />
          {goal ? 'Ta course est passée.' : 'Pas encore d’objectif de course.'}
        </span>
        <Link to="/settings?tab=goals" className="text-neon-cyan hover:underline">
          {goal ? 'Fixer le prochain objectif' : 'Fixer un objectif'} <span aria-hidden>→</span>
        </Link>
      </div>
    );
  // The curve read answers for this goal only: a goal changed since is not projected.
  const data = curve.data?.goal_id === goal.id ? curve.data : undefined;
  const tsb = data?.race_day?.tsb;
  const key = data?.key_session;
  return (
    <section ref={ref} aria-label="Objectif de course" className="glass-panel px-4 py-3 font-sans space-y-1.5">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm text-text-primary">
        <Flag className="w-4 h-4 text-neon-gold shrink-0 self-center" aria-hidden />
        <span className="font-semibold">{goal.name}</span>
        <span className="text-neon-gold">{goal.days_left > 0 ? `J-${goal.days_left}` : 'Jour J'}</span>
        <span className="text-xs text-text-muted">
          {/* A race's distance; a Hyrox's division and date; a block's end (goalKind). */}
          {goal.goal_type === 'hyrox' ? `${goalKind(goal)} · ${longDate(goal.race_date)}` : goalKind(goal)}
        </span>
      </h2>
      {curve.isError ? (
        <p className="text-xs text-text-muted">
          Projection indisponible.{' '}
          <button type="button" onClick={() => void curve.refetch()} className="text-neon-cyan hover:underline">
            Réessayer
          </button>
        </p>
      ) : !data ? (
        <p role="status" className="text-xs text-text-muted">Projection du jour J…</p>
      ) : (
        <>
          {tsb != null && planReachesRaceWeek(data, goal.race_date) ? (
            <p className="text-xs text-text-secondary">
              Fraîcheur prévue le jour J : <span className="text-neon-gold">{formBand(tsb, goal.days_left)}</span>
            </p>
          ) : (
            // A band over weeks of assumed rest would reassure for nothing.
            <p className="text-xs text-text-muted">
              {plannedUntil(data.last_planned)} · repos supposé{data.last_planned ? ' ensuite' : ''}
            </p>
          )}
          {key && (
            <Link to={`/planning?date=${key.date}`} className="block text-xs text-neon-cyan hover:underline">
              Séance clé : {shortDay(key.date)} · {SESSION_TYPE_LABEL[key.session_type] ?? key.session_type}
              {key.target_duration_min ? ` · ${key.target_duration_min} min` : ''} <span aria-hidden>→</span>
            </Link>
          )}
        </>
      )}
    </section>
  );
}
