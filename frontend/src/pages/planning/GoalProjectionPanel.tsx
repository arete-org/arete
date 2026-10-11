import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Flag } from 'lucide-react';
import { Panel } from '@/components/ui';
import { goalsApi } from '@/lib/api';
import { toLocalISODate } from '@/lib/dates';
import { qk } from '@/lib/queryKeys';
import { goalCountdown } from '@/lib/race';

// recharts stays out of the main bundle (see App.tsx): the chart loads with this panel.
const ProjectionChart = lazy(() => import('./ProjectionChart').then((m) => ({ default: m.ProjectionChart })));

const signed = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)}`;

/** Fitness and form projected to the next race, from history and the planned sessions. */
export function GoalProjectionPanel() {
  const { data: goal } = useQuery({ queryKey: qk.nextGoal, queryFn: goalsApi.next });
  const projection = useQuery({
    queryKey: qk.goalProjection(goal?.id),
    queryFn: () => goalsApi.getProjection(goal?.id ?? 0),
    enabled: goal != null,
  });
  if (!goal) return null;
  const data = projection.data;

  return (
    <Panel
      className="mb-4 sm:mb-8"
      delay={0.15}
      title={
        <span className="flex items-center gap-2">
          <Flag className="size-4 text-neon-gold" /> Vers {goal.name}
        </span>
      }
    >
      <p className="text-xs font-sans text-text-muted -mt-2 mb-3">{goalCountdown(goal)}</p>
      {projection.isLoading && <p className="text-sm text-text-muted">Projection en cours…</p>}
      {projection.isError && <p className="text-sm text-danger-red">Projection indisponible.</p>}
      {data && (
        <div className="space-y-3">
          <Suspense fallback={<div className="h-[220px]" />}>
            <ProjectionChart series={data.series} today={toLocalISODate()} />
          </Suspense>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm font-sans">
            <span className="text-text-secondary">
              Forme le jour J : <span className="text-neon-gold">TSB {data.race_day.tsb != null ? signed(data.race_day.tsb) : '—'}</span>
            </span>
            <span className="text-text-secondary">
              Pic de forme (CTL) : <span className="text-neon-cyan">{data.peak_ctl != null ? Math.round(data.peak_ctl) : '—'}</span>
            </span>
          </div>
          {data.planned_sessions === 0 && (
            <p className="text-xs text-text-muted">
              Aucune séance prévue d’ici la course : la courbe suppose du repos.{' '}
              <Link to="/settings?tab=goals" className="text-neon-cyan hover:underline">
                Générer le plan
              </Link>
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
