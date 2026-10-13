import { cn } from '@/lib/utils';

/** A panel's shape while its own data loads, instead of a page-wide spinner. */
export function Skeleton({ label, lines = 2, className }: { label: string; lines?: number; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          aria-hidden
          className={cn('h-4 rounded bg-shadow motion-safe:animate-pulse', lines > 1 && i === lines - 1 && 'w-2/3')}
        />
      ))}
    </div>
  );
}
