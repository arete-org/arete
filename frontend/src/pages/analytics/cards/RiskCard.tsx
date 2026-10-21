import type { Card } from '@/types';
import { StatCard } from '../StatCard';

/** The three numbers « Où est le risque ? » reads over the last 7 days, with its thresholds. */
export function RiskCard({ card, loading, error }: { card?: Card; loading?: boolean; error?: boolean }) {
  return (
    <StatCard
      title="Charge des 7 derniers jours"
      question="La charge monte-t-elle trop vite ou trop uniformément ?"
      card={card}
      term="acwr"
      secondaryLabels={['Monotonie', 'Forme de fond en 7 j']}
      secondaryTerms={['monotonie', 'ctl']}
      previousLabel=""
      loading={loading}
      error={error}
    />
  );
}
