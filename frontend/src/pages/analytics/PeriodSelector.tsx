import type { Period } from '@/types';
import { PERIODS, PERIOD_LABEL, PERIOD_SHORT } from './types';

/** Period switch shared by every section of the page. */
export function PeriodSelector({
  period,
  onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div className="flex gap-1 flex-wrap" role="group" aria-label="Période analysée">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          aria-pressed={period === p}
          title={PERIOD_LABEL[p]}
          className="analysis-tab"
        >
          {PERIOD_SHORT[p]}
        </button>
      ))}
    </div>
  );
}
