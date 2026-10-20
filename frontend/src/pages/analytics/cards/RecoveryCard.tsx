import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Bucket, Card } from '@/types';
import { CHART } from '@/lib/chartTheme';
import type { GlossaryId } from '@/lib/glossary';
import { StatCard } from '../StatCard';
import { ChartGrid, ChartTooltip, bucketAxis, bucketLabel } from '../chartParts';
import { useId } from 'react';

/** One Garmin recovery metric: mean over the window and its trend. */
export function RecoveryCard({
  title,
  question,
  term,
  card,
  bucket,
  color,
  unit,
  previousLabel,
  loading,
  error,
  seconds = false,
}: {
  title: string;
  question: string;
  term: GlossaryId;
  card?: Card;
  bucket: Bucket;
  color: string;
  unit: string;
  previousLabel: string;
  loading?: boolean;
  error?: boolean;
  /** Garmin stores sleep duration in seconds; chart axes present hours. */
  seconds?: boolean;
}) {
  const data = (card?.series ?? []).map((p) => ({
    bucket: p.bucket,
    value: p.value == null ? null : Number(p.value) / (seconds ? 3600 : 1),
  }));
  const gradientId = useId();

  return (
    <StatCard
      title={title}
      question={question}
      term={term}
      card={card}
      secondaryLabels={['Dernière mesure']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <ChartGrid />
          <XAxis {...bucketAxis(bucket)} />
          <YAxis
            domain={['dataMin - 3', 'dataMax + 3']}
            stroke={CHART.axis}
            tick={{ fontSize: 11, fill: CHART.axis }}
            width={40}
            unit={seconds ? ' h' : undefined}
          />
          <ChartTooltip
            labelFormatter={bucketLabel(bucket)}
            formatter={(value: number) => {
              const minutes = Math.round(value * 60);
              return [seconds ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${value.toFixed(0)} ${unit}`.trim(), title];
            }}
          />
          <Area isAnimationActive={false}
            type="monotone"
            dataKey="value"
            name={title}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
