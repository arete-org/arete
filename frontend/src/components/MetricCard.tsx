import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { type ZoneKind, zoneLabel } from '@/lib/fr';
import { cn, getZoneColor } from '@/lib/utils';

interface MetricCardProps {
  title: string;
  value: number | string;
  kind: ZoneKind;
  zone: string | null | undefined;
  subtitle?: string;
  trend?: 'up' | 'down' | 'stable';
}

// Status stays in the badge; the shared card surface remains visually quiet.
const zoneColorMap = {
  green: {
    badge: 'bg-success-green/20 text-success-green',
  },
  orange: {
    badge: 'bg-warning-orange/20 text-warning-orange',
  },
  red: {
    badge: 'bg-danger-red/20 text-danger-red',
  },
  cyan: {
    badge: 'bg-neon-cyan/20 text-neon-cyan',
  },
};

export function MetricCard({ title, value, kind, zone, subtitle, trend }: MetricCardProps) {
  const zoneColor = getZoneColor(kind, zone);
  const colors = zoneColorMap[zoneColor];
  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;

  return (
    <div className="glass-panel p-4 animate-fade-up">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-sans text-text-muted uppercase tracking-wider">{title}</span>
        {trend && (
          <TrendIcon
            className={cn(
              'w-4 h-4',
              trend === 'up' && 'text-success-green',
              trend === 'down' && 'text-danger-red',
              trend === 'stable' && 'text-text-muted'
            )}
          />
        )}
      </div>

      <div className="text-3xl font-sans font-semibold tabular-nums text-text-primary mb-2">{value}</div>

      <div
        className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-sans uppercase', colors.badge)}
      >
        {zoneLabel(kind, zone)}
        {zoneColor === 'green' && ' ✓'}
        {zoneColor === 'red' && ' ⚠'}
      </div>

      {subtitle && <div className="mt-2 text-xs text-text-muted">{subtitle}</div>}
    </div>
  );
}
