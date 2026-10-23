import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { COLORS } from '@/lib/chartTheme';
import { parseLocalDate } from '@/lib/dates';
import { formatKg } from '@/lib/strengthProgress';
import { AXIS, ChartGrid, ChartTooltip, TICK } from '../analytics/chartParts';

const shortDate = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/** Best e1RM per session; loaded lazily so recharts stays out of the Log bundle. */
export function E1rmChart({ points }: { points: { date: string; e1rm: number | null }[] }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <ChartGrid />
        <XAxis dataKey="date" {...AXIS} tick={TICK} tickFormatter={shortDate} minTickGap={28} />
        <YAxis {...AXIS} tick={TICK} width={44} domain={['dataMin - 5', 'dataMax + 5']} />
        <ChartTooltip
          labelFormatter={(iso: string) => shortDate(iso)}
          formatter={(value: number) => [formatKg(Math.round(value * 10) / 10), '1RM estimé']}
        />
        <Line isAnimationActive={false} type="monotone" dataKey="e1rm" stroke={COLORS.neonGold} strokeWidth={2} dot={{ r: 2 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
