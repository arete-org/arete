import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Accent = 'cyan' | 'gold';

const FOCUS: Record<Accent, string> = {
  cyan: 'focus:border-neon-cyan/50',
  gold: 'focus:border-neon-gold/50',
};

/** Shared classes for text-like form controls. */
export function inputClasses(accent: Accent = 'cyan', className?: string) {
  return cn(
    'ui-input w-full bg-abyss border border-border rounded px-4 py-2',
    'text-text-primary font-sans',
    'transition-colors placeholder:text-text-muted/70',
    FOCUS[accent],
    className
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  accent?: Accent;
}

export function Input({ accent = 'cyan', className, ...props }: InputProps) {
  return <input className={inputClasses(accent, className)} {...props} />;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  accent?: Accent;
}

export function Textarea({ accent = 'cyan', className, ...props }: TextareaProps) {
  return (
    <textarea className={inputClasses(accent, cn('text-sm resize-none', className))} {...props} />
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  accent?: Accent;
}

export function Select({ accent = 'cyan', className, children, ...props }: SelectProps) {
  return (
    <select className={inputClasses(accent, className)} {...props}>
      {children}
    </select>
  );
}

interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** Vertical gap between label and control (default mb-2). */
  gap?: 'sm' | 'md';
}

/** Label + control wrapper used across every form in the app. */
export function Field({ label, children, hint, className, gap = 'md' }: FieldProps) {
  return (
    <div className={className}>
      <label
        className={cn(
          'text-xs font-sans text-text-muted block',
          gap === 'md' ? 'mb-2' : 'mb-1'
        )}
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1 font-sans">{hint}</p>}
    </div>
  );
}
