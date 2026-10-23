import { lazy, Suspense } from 'react';
import { Skeleton } from '@/components/ui';
import { importChunk } from '@/lib/chunkReload';
import { curveSummary, NO_LOAD, useFormCurve, useInView } from '@/lib/formCurve';

// recharts stays out of the entry chunk (ARE-46): the chart loads with its data.
const FormCurveChart = lazy(importChunk(() => import('./FormCurveChart').then((m) => ({ default: m.FormCurveChart }))));

const LEGEND = [
  { label: 'Forme de fond', className: 'bg-neon-cyan' },
  { label: 'Fatigue', className: 'bg-chart-red' },
  { label: 'Fraîcheur', className: 'bg-neon-gold' },
];

/** The settled block's height (chart, legend, a three-line caption on a phone), kept while it loads: no jump. */
const SETTLED = 'min-h-[19rem]';

/**
 * One fitness / fatigue / form curve: twelve weeks, then the projection to
 * the next race. Its request waits for the dashboard (`ready`) and for the
 * panel to be on screen; the summary says the curve in words. Without any
 * load (`hasLoad`, from the dashboard), there is nothing to draw nor read.
 * When the dashboard failed (`failed`), so does the curve, with its retry.
 */
export function FormCurvePanel({
  day,
  ready,
  hasLoad,
  failed,
  retry,
}: {
  day: string | undefined;
  ready: boolean;
  hasLoad: boolean | undefined;
  failed: boolean;
  retry: () => void;
}) {
  const [ref, visible] = useInView();
  const curve = useFormCurve(day, ready && hasLoad === true && visible);
  const data = curve.data;
  const unavailable = (onRetry: () => void) => (
    <p className="text-xs font-sans text-danger-red">
      Courbe indisponible.{' '}
      <button type="button" onClick={onRetry} className="text-neon-cyan hover:underline">
        Réessayer
      </button>
    </p>
  );
  const loading = (
    <div className={SETTLED}>
      <Skeleton label="Chargement de la courbe de forme" lines={6} />
    </div>
  );
  return (
    <div ref={ref}>
      {failed ? (
        unavailable(retry)
      ) : hasLoad === false ? (
        <p className="text-sm font-sans text-text-muted">{NO_LOAD}</p>
      ) : curve.isError ? (
        unavailable(() => void curve.refetch())
      ) : !data ? (
        loading
      ) : data.series.length === 0 ? (
        <p className="text-sm font-sans text-text-muted">{curveSummary(data)}</p>
      ) : (
        <figure className={`${SETTLED} space-y-2`}>
          {/* The summary is the chart's text: a screen reader reads it instead of the drawing. */}
          <div aria-hidden className="h-[200px]">
            <Suspense fallback={<Skeleton label="Chargement de la courbe de forme" lines={6} />}>
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
