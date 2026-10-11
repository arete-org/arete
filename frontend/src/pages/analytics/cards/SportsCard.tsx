import type { Card, SportSlice } from '@/types';
import { getSportColor, getSportHex, getSportIconComponent } from '@/lib/sport';
import { SPORT_LABEL } from '@/lib/fr';
import { StatCard } from '../StatCard';

function hoursLabel(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

/** One row per sport: share of the time, in the sport's own colour. */
export function SportsCard({
  card,
  previousLabel,
  loading,
  error,
}: {
  card?: Card;
  previousLabel: string;
  loading?: boolean;
  error?: boolean;
}) {
  const slices = (card?.series ?? []) as unknown as SportSlice[];

  return (
    <StatCard
      title="Répartition des sports"
      question="Le temps d'entraînement part dans quoi ?"
      card={card}
      secondaryLabels={['Sport principal']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      {slices.length === 0 ? (
        <p className="text-sm text-text-muted py-8 text-center">Aucune séance sur la période.</p>
      ) : (
        <ul className="space-y-2">
          {slices.map((s) => {
            const Icon = getSportIconComponent(s.sport);
            return (
              <li key={s.sport} className="flex items-center gap-3">
                <Icon className={`w-4 h-4 shrink-0 ${getSportColor(s.sport)}`} size="sm" />
                <span className="w-28 shrink-0 text-xs font-sans text-text-secondary truncate">
                  {SPORT_LABEL[s.sport] ?? s.sport}
                </span>
                <div className="flex-1 h-2 rounded bg-shadow overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{ width: `${s.pct}%`, backgroundColor: getSportHex(s.sport) }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-xs font-sans text-text-primary tabular-nums">
                  {hoursLabel(s.hours)} · {s.pct.toFixed(0)} %
                </span>
                <span className="w-16 shrink-0 text-right text-xs font-sans text-text-muted tabular-nums">
                  {s.count} séance{s.count > 1 ? 's' : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </StatCard>
  );
}
