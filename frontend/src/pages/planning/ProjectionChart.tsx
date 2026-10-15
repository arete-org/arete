import { Area, Bar, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { CHART, COLORS } from '@/lib/chartTheme';
import { parseLocalDate } from '@/lib/dates';
import type { ProjectionPoint } from '@/types';
import { AXIS, ChartGrid, ChartTooltip, TICK } from '../analytics/chartParts';

const SERIES_NAME: Record<string, string> = {
  ctl: 'Forme de fond',
  atl: 'Fatigue',
  tsb: 'Forme',
  plannedTss: 'Charge prévue',
};

const shortDate = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

const LEGEND = [
  { label: 'Forme de fond', className: 'bg-neon-cyan' },
  { label: 'Fatigue', className: 'bg-chart-red' },
  { label: 'Forme', className: 'bg-neon-gold' },
  { label: 'Jour prévu', className: 'bg-chart-grey opacity-50' },
];

/** Forme de fond, fatigue and forme until race day, in the dashboard's words; bars
 * mark the days whose load comes from the plan. */
export function ProjectionChart({ series, today }: { series: ProjectionPoint[]; today: string }) {
  const data = series.map((p) => ({
    date: p.date,
    ctl: p.ctl,
    atl: p.atl,
    tsb: p.tsb,
    plannedTss: p.planned ? p.tss : null,
  }));

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <ChartGrid />
          <XAxis dataKey="date" {...AXIS} tick={TICK} tickFormatter={shortDate} minTickGap={28} />
          <YAxis yAxisId="load" {...AXIS} tick={TICK} width={44} />
          {/* The planned load has its own hidden scale: daily TSS dwarfs CTL. */}
          <YAxis yAxisId="tss" hide domain={[0, (max: number) => max * 3]} />
          <ChartTooltip
            labelFormatter={(iso: string) =>
              parseLocalDate(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' })
            }
            formatter={(value: number, name: string) => [Math.round(value), SERIES_NAME[name] ?? name]}
          />
          <ReferenceLine yAxisId="load" y={0} stroke={CHART.grid} />
          <Bar yAxisId="tss" dataKey="plannedTss" fill={CHART.grey} opacity={0.3} />
          <Area
            yAxisId="load"
            type="monotone"
            dataKey="tsb"
            stroke={COLORS.neonGold}
            fill={COLORS.neonGold}
            fillOpacity={0.12}
            strokeWidth={1.5}
          />
          <Line yAxisId="load" type="monotone" dataKey="ctl" stroke={COLORS.neonCyan} strokeWidth={2} dot={false} />
          <Line yAxisId="load" type="monotone" dataKey="atl" stroke={CHART.red} strokeWidth={1.5} dot={false} />
          <ReferenceLine
            yAxisId="load"
            x={today}
            stroke={CHART.axis}
            strokeDasharray="4 3"
            label={{ value: 'Aujourd’hui', position: 'insideTopLeft', fill: CHART.label, fontSize: 10 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] font-sans text-text-muted">
        {LEGEND.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1.5">
            <span className={`inline-block w-3 h-1.5 rounded-sm ${item.className}`} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
