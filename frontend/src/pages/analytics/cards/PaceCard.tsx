import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Bucket, Card } from '@/types';
import { CHART, COLORS } from '@/lib/chartTheme';
import { formatPace } from '@/lib/utils';
import { StatCard } from '../StatCard';
import { ChartTooltip, bucketAxis, bucketLabel } from '../chartParts';

/** Median pace per bucket, faster at the top. */
export function PaceCard({
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
    pace_sec_km: p.pace_sec_km === null ? null : Number(p.pace_sec_km),
    n_runs: Number(p.n_runs ?? 0),
    n_graded: Number(p.n_graded ?? 0),
  }));

  return (
    <StatCard
      title="Allure de course"
      term="allure"
      question="L'allure progresse-t-elle à mesure des semaines ? Les sorties vallonnées comptent leur allure ajustée à la pente (GAP)."
      card={card}
      secondaryLabels={['Allure médiane']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis {...bucketAxis(bucket)} />
          <YAxis
            reversed
            domain={['dataMin - 20', 'dataMax + 20']}
            stroke={CHART.axis}
            tick={{ fontSize: 11, fill: CHART.axis }}
            tickFormatter={(v: number) => formatPace(v)}
            width={52}
          />
          <ChartTooltip
            labelFormatter={bucketLabel(bucket)}
            formatter={(value: number, _name: string, item) => {
              const runs = item?.payload?.n_runs ?? 0;
              const graded = item?.payload?.n_graded ?? 0;
              return [
                `${formatPace(value)} /km · ${runs} sortie${runs > 1 ? 's' : ''}${graded ? `, dont ${graded} en GAP` : ''}`,
                'Allure médiane',
              ];
            }}
          />
          <Line isAnimationActive={false}
            type="monotone"
            dataKey="pace_sec_km"
            name="Allure médiane"
            stroke={COLORS.neonGold}
            strokeWidth={2}
            connectNulls={false}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
