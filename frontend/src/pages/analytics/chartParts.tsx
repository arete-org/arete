import type { ReactNode } from 'react';
import { CartesianGrid, Tooltip } from 'recharts';
import type { TooltipProps } from 'recharts';
import type { Bucket } from '@/types';
import { CHART } from '@/lib/chartTheme';
import { formatBucket, formatBucketLong } from './types';

/** Shared recharts props: theme stroke and readable ticks. */
export const AXIS = { stroke: CHART.axis } as const;
export const TICK = { fontSize: 11, fill: CHART.axis } as const;

/** X axis props for a bucketed series. */
export function bucketAxis(bucket: Bucket) {
  return {
    dataKey: 'bucket',
    ...AXIS,
    tick: TICK,
    tickFormatter: (iso: string) => formatBucket(iso, bucket),
    minTickGap: 28,
  } as const;
}

export function axisLabel(value: string, position: 'insideLeft' | 'insideBottom') {
  return {
    value,
    position,
    fill: CHART.label,
    fontSize: 10,
    ...(position === 'insideLeft' ? { angle: -90 } : { offset: -5 }),
  };
}

export function ChartGrid() {
  return <CartesianGrid stroke={CHART.grid} vertical={false} />;
}

export const TOOLTIP_STYLE = {
  backgroundColor: CHART.surface,
  border: `1px solid ${CHART.grid}`,
  color: CHART.text,
  fontSize: 12,
  borderRadius: 'var(--radius-control)',
  padding: 12,
  fontFamily: 'var(--font-sans)',
  maxWidth: 'min(300px, 80vw)',
  whiteSpace: 'normal',
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ChartTooltip(props: TooltipProps<any, any>) {
  return <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--color-shadow)', fillOpacity: 0.4 }} {...props} />;
}

export function TooltipBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-chart-surface border border-chart-grid rounded p-2 text-xs text-chart-text space-y-0.5">
      <div className="font-sans text-text-primary">{title}</div>
      {children}
    </div>
  );
}

/** Tooltip label for a bucket, spelled out. */
export const bucketLabel = (bucket: Bucket) => (iso: string) => formatBucketLong(iso, bucket);
