import { cn } from '@/lib/utils';

interface AdherenceBarProps {
  score: number;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function AdherenceBar({ score, showLabel = true, size = 'md' }: AdherenceBarProps) {
  // Clamp score between 0-100
  const clampedScore = Math.max(0, Math.min(100, score));
  
  // Determine color based on score
  const getColor = () => {
    if (clampedScore >= 90) return 'bg-success-green';
    if (clampedScore >= 75) return 'bg-neon-cyan';
    if (clampedScore >= 50) return 'bg-warning-orange';
    return 'bg-danger-red';
  };

  const heights = {
    sm: 'h-1',
    md: 'h-2',
    lg: 'h-3',
  };

  return (
    <div className="flex items-center gap-2">
      <div className={cn('flex-1 bg-shadow rounded-sm overflow-hidden', heights[size])}>
        <div
          className={cn('h-full transition-all duration-500', getColor())}
          style={{ width: `${clampedScore}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs font-sans text-text-muted min-w-[36px]">
          {clampedScore.toFixed(0)}%
        </span>
      )}
    </div>
  );
}
