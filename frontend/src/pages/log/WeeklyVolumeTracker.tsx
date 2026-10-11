import { Panel } from '@/components/ui';
import { toLocalISODate } from '@/lib/dates';
import type { StrengthSession } from '@/types';

/** Monday of the current week, as a local ISO date. */
function weekStart(): string {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return toLocalISODate(d);
}

export function WeeklyVolumeTracker({
  sessions,
  targetKg,
}: {
  sessions: StrengthSession[];
  targetKg: number;
}) {
  const from = weekStart();
  const week = sessions.filter((s) => s.date >= from);
  const volume = week.reduce((sum, s) => sum + (s.total_volume || 0), 0);
  const sets = week.reduce((sum, s) => sum + (s.total_sets || 0), 0);
  const rated = week.filter((s) => s.overall_rpe != null);
  const avgRpe = rated.length ? rated.reduce((sum, s) => sum + (s.overall_rpe as number), 0) / rated.length : null;
  const pct = targetKg > 0 ? (volume / targetKg) * 100 : 0;

  return (
    <Panel title="VOLUME DE LA SEMAINE" delay={0.1}>
      <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-4">
        <div className="text-center">
          <div className="text-lg sm:text-2xl font-sans font-bold text-neon-cyan">{(volume / 1000).toFixed(1)}k</div>
          <div className="text-xs text-text-muted font-sans">Tonnage (kg)</div>
        </div>
        <div className="text-center">
          <div className="text-lg sm:text-2xl font-sans font-bold text-neon-purple">{sets}</div>
          <div className="text-xs text-text-muted font-sans">Séries</div>
        </div>
        <div className="text-center">
          <div className="text-lg sm:text-2xl font-sans font-bold text-warning-orange">
            {avgRpe === null ? '—' : avgRpe.toFixed(1)}
          </div>
          <div className="text-xs text-text-muted font-sans">RPE moyen</div>
        </div>
      </div>
      <div className="h-2 bg-shadow rounded overflow-hidden">
        <div className="h-full bg-neon-cyan transition-all duration-500" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="text-xs text-text-muted font-sans mt-2 text-right">
        {pct.toFixed(0)} % de l&apos;objectif hebdo ({targetKg.toLocaleString('fr-FR')} kg)
      </div>
    </Panel>
  );
}
