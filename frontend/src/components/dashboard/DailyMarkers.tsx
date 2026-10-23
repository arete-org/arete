import { Button, Panel } from '@/components/ui';
import type { DashboardData } from '@/lib/dashboard';
import { parseLocalDate } from '@/lib/dates';
import { formatDecimal } from '@/lib/fr';

const legsWords = ['Très lourdes', 'Lourdes', 'Normales', 'Légères', 'Très fraîches'];
const measuredDay = (date: string | null | undefined) => date
  ? parseLocalDate(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
  : 'date indisponible';

/** The same canonical preparation as the coach; never substitute the model's health-row score. */
export function DailyMarkers({ fitness, checkin, stats, day, expanded, onDetails }: {
  fitness: DashboardData['fitness'] | undefined;
  checkin: DashboardData['checkin'] | undefined;
  stats: DashboardData['player_stats'] | undefined;
  day: string | undefined;
  expanded: boolean;
  onDetails: () => void;
}) {
  const source = fitness?.readiness_source === 'garmin_training' ? 'Préparation Garmin'
    : fitness?.readiness_source === 'garmin' ? 'VFC et sommeil Garmin' : 'Estimation par la charge';
  return <Panel className="dashboard-panel">
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="text-base font-medium">Tes repères</h2>
      <Button variant="ghost" className="min-h-11" aria-expanded={expanded} aria-controls="dashboard-details" onClick={onDetails}>{expanded ? 'Masquer les détails' : 'Détails de ma forme'}</Button>
    </div>
    <dl className="divide-y divide-border">
      <div className="flex justify-between gap-4 py-3">
        <dt><span className="block text-sm">Préparation</span><span className="mt-1 block text-xs text-text-muted">{fitness ? `${source} · ${measuredDay(fitness.readiness_measured_on ?? (fitness.readiness_source === 'model' ? day : null))}` : 'Mesure indisponible'}</span></dt>
        <dd className="shrink-0 text-sm font-medium tabular-nums">{fitness?.readiness_score != null ? `${Math.round(fitness.readiness_score)} / 100` : '—'}</dd>
      </div>
      <div className="flex justify-between gap-4 py-3">
        <dt><span className="block text-sm">Jambes</span><span className="mt-1 block text-xs text-text-muted">{checkin ? `Ton ressenti · ${measuredDay(checkin.date)}` : 'Pas de ressenti renseigné'}</span></dt>
        <dd className="shrink-0 text-right text-sm font-medium">{checkin ? <>{legsWords[checkin.legs - 1]}<span className="mt-1 block text-xs font-normal text-text-muted">{checkin.legs} / 5</span></> : '—'}</dd>
      </div>
      <div className="flex justify-between gap-4 py-3">
        <dt><span className="block text-sm">Charge de la semaine</span><span className="mt-1 block text-xs text-text-muted">{stats ? stats.xp.detail : 'Séances enregistrées · TSS'}</span></dt>
        <dd className="shrink-0 text-sm font-medium tabular-nums">{stats ? `${formatDecimal(stats.xp.current, 0)} / ${formatDecimal(stats.xp.max, 0)}` : '—'}</dd>
      </div>
    </dl>
  </Panel>;
}
