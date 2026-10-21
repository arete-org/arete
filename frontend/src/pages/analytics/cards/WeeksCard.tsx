import type { Card } from '@/types';
import { StatCard } from '../StatCard';

const gain = (value: number) =>
  `${value > 0 ? '+' : ''}${value.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;

/** « Qu’est-ce qui marche ? »: the weeks grouped by training days, and the forme de fond they gained. */
export function WeeksCard({ card, loading, error }: { card?: Card; loading?: boolean; error?: boolean }) {
  const rows = (card?.series ?? []).map((p) => ({
    days: Number(p.days),
    weeks: Number(p.weeks),
    gain: Number(p.ctl_gain),
  }));
  return (
    <StatCard
      title="Semaines comparées"
      question="Comment ta forme de fond a-t-elle évolué selon tes jours d’entraînement ?"
      card={card}
      term="ctl"
      previousLabel=""
      loading={loading}
      error={error}
    >
      {rows.length > 0 && (
        <table className="analysis-records-table">
          <thead>
            <tr>
              <th scope="col">Jours par semaine</th>
              <th scope="col">Semaines</th>
              <th scope="col">Forme de fond</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.days}>
                <th scope="row">{r.days} j</th>
                <td>{r.weeks}</td>
                <td>{gain(r.gain)} en moyenne</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </StatCard>
  );
}
