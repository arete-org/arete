import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Status = 'online' | 'offline' | 'loading';

const DOT: Record<Status, string> = {
  online: 'bg-success-green',
  offline: 'bg-danger-red',
  loading: 'bg-warning-orange animate-pulse',
};

const STATUS_LABEL: Record<Status, string> = {
  online: 'En ligne',
  offline: 'Hors ligne',
  loading: 'Vérification',
};

const TEXT: Record<Status, string> = {
  online: 'text-success-green',
  offline: 'text-danger-red',
  loading: 'text-warning-orange',
};

export function StatusRow({ icon, label, status }: { icon: ReactNode; label: string; status: Status }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-text-muted">{icon}</span>
      <span className="text-text-secondary font-sans flex-1">{label}</span>
      <div className="flex items-center gap-2">
        <div className={cn('w-3 h-3 rounded-full', DOT[status])} />
        <span className={cn('text-xs font-sans', TEXT[status])}>
          {STATUS_LABEL[status]}
        </span>
      </div>
    </div>
  );
}
