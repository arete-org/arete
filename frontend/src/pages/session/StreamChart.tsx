import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { CHART } from '@/lib/chartTheme';
import { formatElapsed, type ChartRow } from '@/lib/activity';
import { ChartTooltip } from '@/pages/analytics/chartParts';

const TICK = { fontSize: 11, fill: CHART.axis } as const;

interface StreamChartProps {
  rows: ChartRow[];
  dataKey: 'hr' | 'pace' | 'altitude';
  label: string;
  color: string;
  format: (value: number) => string;
  /** Faster at the top: a pace axis reads upside down. */
  reversed?: boolean;
  /** Filled under the line (altitude). */
  area?: boolean;
}

/**
 * One measure over elapsed time. Every chart of the page shares a `syncId`,
 * so hovering one moves the crosshair on the others: one axis per chart, the
 * same moment across all of them.
 */
export function StreamChart({ rows, dataKey, label, color, format, reversed, area }: StreamChartProps) {
  if (!rows.some((r) => r[dataKey] !== null)) return null;
  const common = {
    data: rows,
    syncId: 'session-streams',
    margin: { top: 8, right: 8, bottom: 0, left: -8 },
  };
  const axes = (
    <>
      <CartesianGrid stroke={CHART.grid} vertical={false} />
      <XAxis
        dataKey="t"
        type="number"
        domain={['dataMin', 'dataMax']}
        stroke={CHART.axis}
        tick={TICK}
        tickFormatter={formatElapsed}
        minTickGap={32}
      />
      <YAxis
        reversed={reversed}
        domain={['auto', 'auto']}
        stroke={CHART.axis}
        tick={TICK}
        tickFormatter={format}
        width={48}
      />
      <ChartTooltip
        cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
        labelFormatter={(t: number) => formatElapsed(t)}
        formatter={(value: number) => [format(value), label]}
      />
    </>
  );
  return (
    <figure>
      <figcaption className="text-sm font-medium text-text-secondary mb-2">{label}</figcaption>
      <ResponsiveContainer width="100%" height={180}>
        {area ? (
          <AreaChart {...common}>
            {axes}
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.15}
              connectNulls={false}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        ) : (
          <LineChart {...common}>
            {axes}
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              connectNulls={false}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </figure>
  );
}
