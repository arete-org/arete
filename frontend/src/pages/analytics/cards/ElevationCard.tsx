import { Bar, ComposedChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Bucket, Card } from '@/types';
import { CHART, COLORS } from '@/lib/chartTheme';
import { StatCard } from '../StatCard';
import { ChartGrid, ChartTooltip, bucketAxis, bucketLabel } from '../chartParts';

/** Climbing per bucket, running then walking, with the running m/km as a line. */
export function ElevationCard({
  card,
  bucket,
  previousLabel,
  loading,
  error,
}: {
  card?: Card;
  bucket: Bucket;
  previousLabel: string;
  loading?: boolean;
  error?: boolean;
}) {
  const data = (card?.series ?? []).map((p) => ({
    bucket: p.bucket,
    run_m: Number(p.run_m ?? 0),
    walk_m: Number(p.walk_m ?? 0),
    m_per_km: p.m_per_km === null ? null : Number(p.m_per_km),
  }));

  return (
    <StatCard
      title="Dénivelé"
      question="Combien de mètres grimpés, et sur quel terrain ?"
      card={card}
      secondaryLabels={['D+ par km couru', 'Plus gros D+']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <ChartGrid />
          <XAxis {...bucketAxis(bucket)} />
          <YAxis yAxisId="m" stroke={CHART.axis} tick={{ fontSize: 11, fill: CHART.axis }} unit=" m" width={56} />
          <YAxis
            yAxisId="ratio"
            orientation="right"
            stroke={CHART.axis}
            tick={{ fontSize: 11, fill: CHART.axis }}
            unit=" m/km"
            width={60}
          />
          <ChartTooltip
            labelFormatter={bucketLabel(bucket)}
            formatter={(value: number, name: string) => [
              name === 'D+ par km couru' ? `${value.toFixed(0)} m/km` : `${value.toFixed(0)} m`,
              name,
            ]}
          />
          <Bar isAnimationActive={false} yAxisId="m" dataKey="run_m" name="Course" stackId="m" fill={COLORS.neonCyan} />
          <Bar isAnimationActive={false} yAxisId="m" dataKey="walk_m" name="Marche, rando" stackId="m" fill={CHART.purple} radius={[2, 2, 0, 0]} />
          <Line isAnimationActive={false}
            yAxisId="ratio"
            type="monotone"
            dataKey="m_per_km"
            name="D+ par km couru"
            stroke={COLORS.neonGold}
            strokeWidth={2}
            connectNulls={false}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
