import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Card } from '@/types';
import { CHART, COLORS } from '@/lib/chartTheme';
import { StatCard } from '../StatCard';
import { AXIS, ChartTooltip, TICK } from '../chartParts';

const day = (iso: unknown) =>
  typeof iso === 'string' ? new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

/** Best climbing speed per duration, like a power curve: the period against the all-time record. */
export function VamCard({
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
  const data = (card?.series ?? []).map((p) => ({
    label: `${p.minutes} min`,
    period: p.period === null ? null : Number(p.period),
    record: p.record === null ? null : Number(p.record),
    period_date: p.period_date,
    record_date: p.record_date,
    record_name: p.record_name,
  }));

  return (
    <StatCard
      title="Vitesse ascensionnelle"
      question="À quelle vitesse je monte, sur 5 min comme sur une heure ? (sorties à pied avec les flux)"
      card={card}
      secondaryLabels={['Record 30 min', 'Meilleure 5 min']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} tick={TICK} />
          <YAxis stroke={CHART.axis} tick={{ fontSize: 11, fill: CHART.axis }} unit=" m/h" width={72} domain={[0, 'auto']} />
          <ChartTooltip
            formatter={(value: number, name: string, item) => {
              const payload = item?.payload ?? {};
              const when = name === 'Record' ? `${day(payload.record_date)}${payload.record_name ? ` · ${payload.record_name}` : ''}` : day(payload.period_date);
              return [`${Math.round(value).toLocaleString('fr-FR')} m/h${when ? ` · ${when}` : ''}`, name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line isAnimationActive={false} type="monotone" dataKey="record" name="Record" stroke={CHART.purple} strokeWidth={2} strokeDasharray="4 3" connectNulls={false} dot={{ r: 3 }} />
          <Line isAnimationActive={false} type="monotone" dataKey="period" name="Période" stroke={COLORS.neonGold} strokeWidth={2} connectNulls={false} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
