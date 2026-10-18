import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Bucket, Card, HrZoneModel } from '@/types';
import { CHART, HR_ZONE_COLORS } from '@/lib/chartTheme';
import { StatCard } from '../StatCard';
import { ChartGrid, ChartTooltip, TooltipBox, bucketAxis } from '../chartParts';
import { formatBucketLong } from '../types';

const ZONES = ['z1', 'z2', 'z3', 'z4', 'z5'] as const;
const ZONE_NAME: Record<string, string> = {
  z1: 'Z1 récupération',
  z2: 'Z2 endurance',
  z3: 'Z3 tempo',
  z4: 'Z4 seuil',
  z5: 'Z5 VO2max',
};

function minutesLabel(min: number): string {
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h${String(min % 60).padStart(2, '0')}` : `${min} min`;
}

/** Time in heart-rate zones per bucket, as minutes or as a share. */
/** "150-157 bpm" for one zone of the athlete's model. */
function rangeLabel(model: HrZoneModel | undefined, zone: string): string {
  const range = model?.ranges.find((r) => r.zone === zone);
  if (!range) return '';
  return range.max === null ? `${range.min}+ bpm` : `${range.min}-${range.max} bpm`;
}

export function ZonesCard({
  card,
  bucket,
  previousLabel,
  model,
  loading,
  error,
}: {
  card?: Card;
  bucket: Bucket;
  previousLabel: string;
  model?: HrZoneModel;
  loading?: boolean;
  error?: boolean;
}) {
  const [mode, setMode] = useState<'min' | 'pct'>('min');
  const suffix = mode === 'pct' ? '_pct' : '';
  const data = card?.series ?? [];

  return (
    <StatCard
      title="Zones cardiaques"
      question="Quelle part du temps passée en facile, et quelle part en dur ?"
      card={card}
      secondaryLabels={['Z4-Z5', 'Temps mesuré']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-text-muted">
          {model
            ? `Zones calculées sur ${model.basis === 'lthr' ? 'ton seuil' : 'ta FC max'} de ${model.reference} bpm`
            : ''}
        </p>
        <div className="flex gap-1" role="group" aria-label="Unité des zones">
        {(['min', 'pct'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className="analysis-tab"
          >
            {m === 'min' ? 'Minutes' : '%'}
          </button>
        ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <ChartGrid />
          <XAxis {...bucketAxis(bucket)} />
          <YAxis
            stroke={CHART.axis}
            tick={{ fontSize: 11, fill: CHART.axis }}
            width={44}
            unit={mode === 'pct' ? ' %' : ''}
            domain={mode === 'pct' ? [0, 100] : undefined}
          />
          <ChartTooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as Record<string, number>;
              return (
                <TooltipBox title={formatBucketLong(String(label), bucket)}>
                  {ZONES.map((z, i) => (
                    <div key={z} style={{ color: HR_ZONE_COLORS[i] }}>
                      {ZONE_NAME[z]} {rangeLabel(model, z)} : {minutesLabel(Number(point[z] ?? 0))} (
                      {Number(point[`${z}_pct`] ?? 0).toFixed(0)} %)
                    </div>
                  ))}
                </TooltipBox>
              );
            }}
          />
          {ZONES.map((z, i) => (
            <Bar isAnimationActive={false}
              key={z}
              dataKey={`${z}${suffix}`}
              name={ZONE_NAME[z]}
              stackId="z"
              fill={HR_ZONE_COLORS[i]}
              radius={i === ZONES.length - 1 ? [2, 2, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
