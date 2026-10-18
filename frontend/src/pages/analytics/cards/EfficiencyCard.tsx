import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Bucket, Card } from '@/types';
import { CHART, COLORS } from '@/lib/chartTheme';
import { StatCard } from '../StatCard';
import { ChartTooltip, bucketAxis, bucketLabel } from '../chartParts';

/** Decoupling per bucket, with the cardiac cost of one km/h beside it. */
export function EfficiencyCard({
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
    decoupling_pct: p.decoupling_pct === null ? null : Number(p.decoupling_pct),
    efficiency: p.efficiency === null ? null : Number(p.efficiency),
  }));

  return (
    <StatCard
      title="Découplage cardiaque"
      question="Le cœur dérive-t-il quand la sortie s'allonge ?"
      card={card}
      secondaryLabels={['Coût cardiaque']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis {...bucketAxis(bucket)} />
          <YAxis
            yAxisId="d"
            stroke={CHART.axis}
            tick={{ fontSize: 11, fill: CHART.axis }}
            unit=" %"
            width={48}
          />
          <YAxis
            yAxisId="e"
            orientation="right"
            stroke={CHART.axis}
            tick={{ fontSize: 11, fill: CHART.axis }}
            width={44}
          />
          <ChartTooltip
            labelFormatter={bucketLabel(bucket)}
            formatter={(value: number, name: string) => [
              name === 'Découplage' ? `${value.toFixed(1)} %` : value.toFixed(1),
              name,
            ]}
          />
          <ReferenceLine yAxisId="d" y={5} stroke={CHART.green} strokeDasharray="4 4" />
          <Line isAnimationActive={false}
            yAxisId="d"
            type="monotone"
            dataKey="decoupling_pct"
            name="Découplage"
            stroke={COLORS.neonCyan}
            strokeWidth={2}
            connectNulls={false}
            dot={{ r: 3 }}
          />
          <Line isAnimationActive={false}
            yAxisId="e"
            type="monotone"
            dataKey="efficiency"
            name="Coût cardiaque"
            stroke={CHART.purple}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            connectNulls={false}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
