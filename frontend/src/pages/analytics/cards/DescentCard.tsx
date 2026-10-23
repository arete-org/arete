import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Card } from '@/types';
import { CHART, COLORS } from '@/lib/chartTheme';
import { formatPace } from '@/lib/utils';
import { StatCard } from '../StatCard';
import { AXIS, ChartTooltip, TICK } from '../chartParts';

/** "Plat", or the descent's steepness range in percent ("5–10"): short enough for a phone. */
const bandLabel = (min: number, max: number) => (min === -2 && max === 2 ? 'Plat' : `${-max}–${-min}`);

/** Running speed per band of negative grade, the flat as reference. */
export function DescentCard({
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
  const data = (card?.series ?? []).map((p) => {
    const paceSec = p.pace_sec_km === null ? null : Number(p.pace_sec_km);
    return {
      label: bandLabel(Number(p.min), Number(p.max)),
      speed: paceSec ? Math.round((3600 / paceSec) * 10) / 10 : null,
      pace_sec_km: paceSec,
      minutes: Number(p.minutes ?? 0),
    };
  });
  const flat = data.find((d) => d.label === 'Plat')?.speed ?? null;

  return (
    <StatCard
      title="Descente"
      question="Vais-je plus vite en descente que sur le plat ? Vitesse par pente, en % (sorties de course avec les flux)"
      card={card}
      secondaryLabels={['Allure sur le plat']}
      previousLabel={previousLabel}
      loading={loading}
      error={error}
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} tick={{ ...TICK, fontSize: 10 }} interval={0} />
          <YAxis stroke={CHART.axis} tick={{ fontSize: 11, fill: CHART.axis }} unit=" km/h" width={64} />
          {flat !== null && <ReferenceLine y={flat} stroke={CHART.axis} strokeDasharray="4 3" />}
          <ChartTooltip
            formatter={(_value: number, _name: string, item) => {
              const payload = item?.payload ?? {};
              return [
                payload.pace_sec_km ? `${formatPace(payload.pace_sec_km)} /km · ${payload.minutes} min` : `${payload.minutes} min, trop peu`,
                'Allure',
              ];
            }}
          />
          <Bar isAnimationActive={false} dataKey="speed" name="Vitesse" fill={COLORS.neonCyan} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </StatCard>
  );
}
