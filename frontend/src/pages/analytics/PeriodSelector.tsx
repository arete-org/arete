import type { Period } from '@/types';
import { cn } from '@/lib/utils';
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
          className={cn(
            'px-3 py-1 text-xs font-sans rounded border transition-colors',
            period === p
              ? 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/50'
              : 'bg-abyss text-text-secondary border-text-muted/30 hover:text-text-primary hover:border-text-muted/60'
          )}
        >
          {PERIOD_SHORT[p]}
        </button>
      ))}
    </div>
  );
}
