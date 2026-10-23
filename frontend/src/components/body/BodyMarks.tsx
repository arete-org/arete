import { formatKg, painTone, shortDate, type WeightEntry } from '@/lib/bodyLog';
import { cn } from '@/lib/utils';

const TONE: Record<ReturnType<typeof painTone>, string> = {
  calm: 'text-text-secondary',
  warning: 'text-signal-warning',
  danger: 'text-signal-danger',
};

/** « 5/10 »: the colour repeats the number's tone, never carries it alone. */
export function Intensity({ value }: { value: number }) {
  return <span className={cn('font-semibold tabular-nums', TONE[painTone(value)])}>{value}/10</span>;
}

/** The weights as one line, oldest to newest; the page lists them as its table. */
export function WeightLine({ weights }: { weights: WeightEntry[] }) {
  if (weights.length < 2) return null;
  const values = weights.map((w) => w.weight_kg);
  const low = Math.min(...values) - 0.5;
  const high = Math.max(...values) + 0.5;
  const first = Date.parse(weights[0].date);
  const span = Math.max(1, Date.parse(weights[weights.length - 1].date) - first);
  const x = (w: WeightEntry) => 8 + ((Date.parse(w.date) - first) / span) * 284;
  const y = (w: WeightEntry) => 8 + ((high - w.weight_kg) / (high - low)) * 64;
  const from = weights[0];
  const to = weights[weights.length - 1];
  return (
    <svg
      viewBox="0 0 300 80"
      className="weight-line h-20 w-[300px] max-w-full text-neon-cyan"
      role="img"
      aria-label={`Poids : de ${formatKg(from.weight_kg)} le ${shortDate(from.date)} à ${formatKg(to.weight_kg)} le ${shortDate(to.date)}`}
    >
      <polyline
        points={weights.map((w) => `${x(w)},${y(w)}`).join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {weights.map((w) => (
        <circle key={w.date} cx={x(w)} cy={y(w)} r={4} fill="currentColor" stroke="var(--surface-card)" strokeWidth={2}>
          <title>{`${shortDate(w.date, true)} : ${formatKg(w.weight_kg)}`}</title>
        </circle>
      ))}
    </svg>
  );
}
