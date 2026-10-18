import type { Card, SportSlice } from '@/types';
import { getSportHex } from '@/lib/sport';
import { SPORT_LABEL } from '@/lib/fr';
import { StatCard } from '../StatCard';

function hoursLabel(hours: number): string {
  const minutes = Math.round(hours * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
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
      question="Comment se répartit ton temps d’entraînement ?"
      card={card}
      secondaryLabels={['Sport principal']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      {slices.length === 0 ? (
        <p className="text-sm text-text-muted py-8 text-center">Aucune séance sur la période.</p>
      ) : (
        <ul className="analysis-sports">
          {slices.map((s) => {
            return (
              <li key={s.sport} className="analysis-sport">
                <span className="text-text-primary">
                  {SPORT_LABEL[s.sport] ?? s.sport}
                </span>
                <span className="text-text-secondary tabular-nums">
                  {hoursLabel(s.hours)} · {s.pct.toFixed(0)} %
                </span>
                <div className="analysis-sport-bar h-2 rounded bg-shadow overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{ width: `${s.pct}%`, backgroundColor: getSportHex(s.sport) }}
                  />
                </div>
                <span className="analysis-sport-count text-[10px] text-text-muted tabular-nums">
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
