import { lazy, Suspense, useRef } from 'react';
import { Skeleton } from '@/components/ui';
import { importChunk } from '@/lib/chunkReload';
import { curveSummary, useFormCurve, useInView } from '@/lib/formCurve';

// recharts stays out of the entry chunk (ARE-46): the chart loads with its data.
const FormCurveChart = lazy(importChunk(() => import('./FormCurveChart').then((m) => ({ default: m.FormCurveChart }))));

const LEGEND = [
  { label: 'Forme de fond', className: 'bg-neon-cyan' },
  { label: 'Fatigue', className: 'bg-chart-red' },
  { label: 'Forme', className: 'bg-neon-gold' },
];

/**
 * One fitness / fatigue / form curve: twelve weeks, then the projection to
 * the next race. Its request waits for the dashboard (`ready`) and for the
 * panel to be on screen; the summary says the curve in words.
 */
export function FormCurvePanel({ day, ready }: { day: string | undefined; ready: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref);
  const curve = useFormCurve(day, ready && visible);
  const data = curve.data;
  const skeleton = <Skeleton label="Chargement de la courbe de forme" lines={4} />;
  return (
    <div ref={ref}>
      {curve.isError ? (
        <p className="text-xs font-sans text-danger-red">
          Courbe indisponible.{' '}
          <button type="button" onClick={() => void curve.refetch()} className="text-neon-cyan hover:underline">
            Réessayer
          </button>
        </p>
      ) : !data ? (
        skeleton
      ) : data.series.length === 0 ? (
        <p className="text-sm font-sans text-text-muted">{curveSummary(data)}</p>
      ) : (
        <figure className="space-y-2">
          {/* The summary is the chart's text: a screen reader reads it instead of the drawing. */}
          <div aria-hidden>
            <Suspense fallback={skeleton}>
              <FormCurveChart series={data.series} today={data.today} />
            </Suspense>
          </div>
          <div aria-hidden className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-sans text-text-muted">
            {LEGEND.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5">
                <span className={`inline-block w-3 h-1.5 rounded-sm ${item.className}`} />
                {item.label}
              </span>
            ))}
            {data.goal_id != null && <span>Pointillés : projection</span>}
          </div>
          <figcaption className="text-xs font-sans text-text-secondary">{curveSummary(data)}</figcaption>
        </figure>
      )}
    </div>
  );
}
