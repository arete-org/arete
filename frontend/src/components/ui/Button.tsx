import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from './Spinner';

export type ButtonVariant =
  | 'cyan'
  | 'purple'
  | 'gold'
  | 'green'
  | 'danger'
  | 'strava'
  | 'outline'
  | 'ghost';

type Size = 'sm' | 'md' | 'lg';

/** Tinted button: bg/10 border/30, hover bg/20 (the app's default). */
const TINT: Record<ButtonVariant, string> = {
  cyan: 'bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20',
  purple: 'bg-neon-purple/10 border border-neon-purple/30 text-neon-purple hover:bg-neon-purple/20',
  gold: 'bg-neon-gold/10 border border-neon-gold/30 text-neon-gold hover:bg-neon-gold/20',
  green: 'bg-success-green/10 border border-success-green/30 text-success-green hover:bg-success-green/20',
  danger: 'bg-danger-red/10 border border-danger-red/30 text-danger-red hover:bg-danger-red/20',
  strava: 'bg-strava/10 border border-strava/30 text-strava hover:bg-strava/20',
  outline: 'bg-abyss border border-text-muted/30 text-text-muted hover:border-text-muted/50',
  ghost: 'text-text-muted hover:text-text-primary',
};

/** Variant classes supply fallbacks; index.css owns the solid primary treatment. */
const STRONG: Record<ButtonVariant, string> = {
  cyan: 'bg-neon-cyan/20 border border-neon-cyan/50 text-neon-cyan hover:bg-neon-cyan/30',
  purple: 'bg-neon-purple/20 border border-neon-purple/50 text-neon-purple hover:bg-neon-purple/30',
  gold: 'bg-neon-gold/20 border border-neon-gold/50 text-neon-gold hover:bg-neon-gold/30',
  green: 'bg-success-green/20 border border-success-green/30 text-success-green hover:bg-success-green/30',
  danger: 'bg-danger-red/20 border border-danger-red/50 text-danger-red hover:bg-danger-red/30',
  strava: 'bg-strava/20 border border-strava/50 text-strava hover:bg-strava/30',
  outline: 'bg-abyss border border-text-muted/30 text-text-primary hover:border-neon-cyan/50',
  ghost: 'text-text-secondary hover:text-text-primary',
};

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-4 py-3 text-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  strong?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = 'cyan',
  size = 'md',
  strong = false,
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      data-strong={strong}
      disabled={disabled || loading}
      className={cn(
        'ui-button inline-flex items-center justify-center gap-2 rounded font-sans transition-colors duration-150 motion-reduce:transition-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        SIZES[size],
        strong ? STRONG[variant] : TINT[variant],
        fullWidth && 'w-full',
        className
      )}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
