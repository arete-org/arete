import { AlertTriangle, WifiOff } from 'lucide-react';
import { AretePresence } from './AreteBrand';
import { cn } from '@/lib/utils';

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Chargement…' }: LoadingStateProps) {
  return (
    <div role="status" className="flex flex-col items-center justify-center py-12 animate-fade-in">
      <AretePresence size={40} />
      <span className="mt-4 font-sans text-sm text-neon-cyan">{message}</span>
    </div>
  );
}

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({ message = 'Connexion perdue', onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 animate-scale-in">
      <div className="p-4 rounded-full bg-danger-red/20 mb-4">
        <WifiOff className="w-8 h-8 text-danger-red" />
      </div>
      <span className="font-sans text-sm text-danger-red mb-2">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'mt-4 px-4 py-2 font-sans text-sm',
            'bg-abyss border border-text-muted/30 rounded',
            'hover:border-neon-cyan/50 hover:text-neon-cyan',
            'transition-all duration-200'
          )}
        >
          Réessayer
        </button>
      )}
    </div>
  );
}

interface EmptyStateProps {
  message?: string;
  action?: string;
}

export function EmptyState({ message = 'Aucune donnée', action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center animate-fade-in">
      <div className="p-4 rounded-full bg-shadow mb-4">
        <AlertTriangle className="w-8 h-8 text-text-muted" />
      </div>
      <span className="font-sans text-sm text-text-muted">{message}</span>
      {action && <span className="mt-2 text-xs text-text-muted/70 font-sans">{action}</span>}
    </div>
  );
}

interface SystemAlertProps {
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  onDismiss?: () => void;
}

const alertStyles = {
  info: { bg: 'bg-neon-cyan/10', border: 'border-neon-cyan/30', text: 'text-neon-cyan' },
  warning: { bg: 'bg-warning-orange/10', border: 'border-warning-orange/30', text: 'text-warning-orange' },
  error: { bg: 'bg-danger-red/10', border: 'border-danger-red/30', text: 'text-danger-red' },
  success: { bg: 'bg-success-green/10', border: 'border-success-green/30', text: 'text-success-green' },
};

export function SystemAlert({ type, message, onDismiss }: SystemAlertProps) {
  const styles = alertStyles[type];

  return (
    <div
      className={cn(
        'flex items-center justify-between p-3 rounded border animate-fade-down',
        styles.bg,
        styles.border
      )}
    >
      <span className={cn('font-sans text-sm', styles.text)}>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className={cn('ml-4 text-xs hover:underline', styles.text)}>
          Fermer
        </button>
      )}
    </div>
  );
}
