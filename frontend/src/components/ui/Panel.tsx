import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PanelProps {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Tailwind text color class for the title (default text-text-primary). */
  titleTone?: string;
  /** glass = primary card surface, inset = quieter nested surface. */
  variant?: 'glass' | 'inset';
  /** Entrance animation delay in seconds (0 disables the stagger). */
  delay?: number;
  animate?: boolean;
  style?: CSSProperties;
}

/**
 * Titled card. `glass` replaces `<div className="glass-panel p-3 sm:p-4">` + h2,
 * `inset` replaces `<div className="p-4 bg-abyss/50 rounded border border-text-muted/20">` + h2.
 * The title is an h2: panels sit right under the page's h1.
 */
export function Panel({
  title,
  children,
  className,
  titleTone = 'text-text-primary',
  variant = 'glass',
  delay = 0,
  animate = variant === 'glass',
  style,
}: PanelProps) {
  return (
    <div
      className={cn(
        variant === 'glass'
          ? 'glass-panel p-4 sm:p-6'
          : 'ui-inset p-4',
        animate && 'animate-fade-up',
        className
      )}
      style={delay ? { animationDelay: `${delay}s`, ...style } : style}
    >
      {title && (
        <h2
          className={cn(
            'font-sans font-medium',
            variant === 'glass' ? 'text-[15px] mb-4' : 'text-xs mb-3',
            titleTone
          )}
        >
          {title}
        </h2>
      )}
      {children}
    </div>
  );
}
