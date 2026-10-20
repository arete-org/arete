import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { CHART, COLORS } from '@/lib/chartTheme';
import { parseLocalDate } from '@/lib/dates';
import type { CurvePoint } from '@/lib/formCurve';
import { AXIS, ChartGrid, ChartTooltip, TICK } from '@/pages/analytics/chartParts';

/** Plain words, as the coach says them: CTL, ATL and TSB stay out of the chart. */
const CURVE_LABEL: Record<string, string> = {
  ctl: 'Forme de fond',
  atl: 'Fatigue',
  tsb: 'Fraîcheur',
  ctlPlan: 'Forme de fond (prévue)',
  atlPlan: 'Fatigue (prévue)',
  tsbPlan: 'Fraîcheur (prévue)',
};

const shortDate = (iso: string) => parseLocalDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/**
 * Forme de fond, fatigue and fraîcheur: solid up to the last logged day, dotted for the
 * projection to race day. recharts loads with this chunk only (ARE-46).
 */
export function FormCurveChart({ series, today }: { series: CurvePoint[]; today: string }) {
  // Solid up to the last logged day (the server sends it up to today from the
  // load only), dotted after it; that day belongs to both halves so the
  // dotted lines start where the solid ones end.
  let last = -1;
  series.forEach((p, i) => {
    if (p.date <= today && !p.planned) last = i;
  });
  const data = series.map((p, i) => {
    const past = i <= last;
    const future = i >= last;
    return {
      date: p.date,
      ctl: past ? p.ctl : null,
      atl: past ? p.atl : null,
      tsb: past ? p.tsb : null,
      ctlPlan: future ? p.ctl : null,
      atlPlan: future ? p.atl : null,
      tsbPlan: future ? p.tsb : null,
    };
  });
  const projected = last < series.length - 1;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <ChartGrid />
        <XAxis dataKey="date" {...AXIS} tick={TICK} tickFormatter={shortDate} minTickGap={32} />
        <YAxis {...AXIS} tick={TICK} width={40} />
        <ChartTooltip
          labelFormatter={(iso: string) =>
            parseLocalDate(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' })
          }
          formatter={(value: number, name: string) => [Math.round(value), CURVE_LABEL[name] ?? name]}
        />
        <ReferenceLine y={0} stroke={CHART.grid} />
        <Area type="monotone" dataKey="tsb" stroke={COLORS.neonGold} fill={COLORS.neonGold} fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
        <Line type="monotone" dataKey="ctl" stroke={COLORS.neonCyan} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="atl" stroke={CHART.red} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        {projected && (
          <>
            <Line type="monotone" dataKey="tsbPlan" stroke={COLORS.neonGold} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="ctlPlan" stroke={COLORS.neonCyan} strokeDasharray="4 3" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="atlPlan" stroke={CHART.red} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <ReferenceLine x={today} stroke={CHART.axis} strokeDasharray="4 3" label={{ value: 'Aujourd’hui', position: 'insideTopLeft', fill: CHART.label, fontSize: 10 }} />
          </>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
