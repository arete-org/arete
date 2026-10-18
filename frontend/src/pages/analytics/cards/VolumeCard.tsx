import { Bar, ComposedChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Bucket, Card } from '@/types';
import { CHART, COLORS } from '@/lib/chartTheme';
import { StatCard } from '../StatCard';
import { ChartGrid, ChartTooltip, bucketAxis, bucketLabel } from '../chartParts';

/** Kilometres per bucket, running first, with the time spent as a line. */
export function VolumeCard({
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
    run_km: Number(p.run_km ?? 0),
    other_km: Math.max(Number(p.km ?? 0) - Number(p.run_km ?? 0), 0),
    hours: Number(p.hours ?? 0),
  }));

  return (
    <StatCard
      title="Volume"
      question="Combien de kilomètres et d'heures sur la période ?"
      card={card}
      secondaryLabels={['Temps total', 'Distance tous sports']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <ChartGrid />
          <XAxis {...bucketAxis(bucket)} />
          <YAxis yAxisId="km" stroke={CHART.axis} tick={{ fontSize: 11, fill: CHART.axis }} unit=" km" width={52} />
          <YAxis
            yAxisId="h"
            orientation="right"
            stroke={CHART.axis}
            tick={{ fontSize: 11, fill: CHART.axis }}
            tickFormatter={(value: number) => value.toLocaleString('fr-FR')}
            unit=" h"
            width={52}
          />
          <ChartTooltip
            labelFormatter={bucketLabel(bucket)}
            formatter={(value: number, name: string) => [
              name === 'Temps' ? `${value.toFixed(1)} h` : `${value.toFixed(1)} km`,
              name,
            ]}
          />
          <Bar isAnimationActive={false} yAxisId="km" dataKey="run_km" name="Course" stackId="km" fill={COLORS.neonCyan} radius={[0, 0, 0, 0]} />
          <Bar isAnimationActive={false} yAxisId="km" dataKey="other_km" name="Autres sports" stackId="km" fill={CHART.purple} radius={[2, 2, 0, 0]} />
          <Line isAnimationActive={false} yAxisId="h" type="monotone" dataKey="hours" name="Temps" stroke={COLORS.neonGold} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
