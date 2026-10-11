import { cn } from '@/lib/utils';

/** RPE ladder: ≤6 easy (green), ≤8 hard (orange), >8 maximal (red). */
export function rpeTone(rpe: number | null | undefined): 'green' | 'orange' | 'red' | 'muted' {
  if (rpe == null) return 'muted';
  if (rpe <= 6) return 'green';
  if (rpe <= 8) return 'orange';
  return 'red';
}

export const RPE_TEXT = {
  green: 'text-success-green',
  orange: 'text-warning-orange',
  red: 'text-danger-red',
  muted: 'text-text-muted',
} as const;

const RPE_BADGE = {
  green: 'bg-success-green/20 text-success-green',
  orange: 'bg-warning-orange/20 text-warning-orange',
  red: 'bg-danger-red/20 text-danger-red',
  muted: 'bg-text-muted/10 text-text-muted',
} as const;

interface RpeBadgeProps {
  rpe: number | null | undefined;
  /** Show "—" when rpe is null instead of rendering nothing. */
  showEmpty?: boolean;
  className?: string;
}

export function RpeBadge({ rpe, showEmpty = false, className }: RpeBadgeProps) {
  if (rpe == null && !showEmpty) return null;
  return (
    <span className={cn('px-2 py-0.5 rounded text-xs font-sans', RPE_BADGE[rpeTone(rpe)], className)}>
      RPE {rpe ?? '—'}
    </span>
  );
}
