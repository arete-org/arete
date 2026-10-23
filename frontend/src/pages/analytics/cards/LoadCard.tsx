import { Area, Bar, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Bucket, Card } from '@/types';
import { CHART, COLORS } from '@/lib/chartTheme';
import { StatCard } from '../StatCard';
import { ChartGrid, ChartTooltip, bucketAxis, bucketLabel } from '../chartParts';

/** Fitness, fatigue and freshness on one axis, the daily load behind them. */
export function LoadCard({
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
    ctl: p.ctl === null ? null : Number(p.ctl),
    atl: p.atl === null ? null : Number(p.atl),
    tsb: p.tsb === null ? null : Number(p.tsb),
    tss: Number(p.tss ?? 0),
  }));

  return (
    <StatCard
      title="Forme de fond et fatigue"
      question="Où en sont la forme de fond, la fatigue et la fraîcheur ?"
      card={card}
      secondaryLabels={['Fraîcheur', 'Fatigue']}
      term="ctl"
      secondaryTerms={['tsb', 'atl']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <ChartGrid />
          <XAxis {...bucketAxis(bucket)} />
          <YAxis stroke={CHART.axis} tick={{ fontSize: 11, fill: CHART.axis }} width={44} />
          <ChartTooltip
            labelFormatter={bucketLabel(bucket)}
            formatter={(value: number, name: string) => [value?.toFixed?.(0) ?? value, name]}
          />
          <ReferenceLine y={0} stroke={CHART.grid} />
          <Bar isAnimationActive={false} dataKey="tss" name="Charge" fill={CHART.grey} opacity={0.35} />
          <Area isAnimationActive={false} type="monotone" dataKey="tsb" name="Fraîcheur" stroke={COLORS.neonGold} fill={COLORS.neonGold} fillOpacity={0.12} strokeWidth={1.5} connectNulls={false} />
          <Line isAnimationActive={false} type="monotone" dataKey="ctl" name="Forme de fond" stroke={COLORS.neonCyan} strokeWidth={2} dot={false} connectNulls={false} />
          <Line isAnimationActive={false} type="monotone" dataKey="atl" name="Fatigue" stroke={CHART.red} strokeWidth={1.5} dot={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
