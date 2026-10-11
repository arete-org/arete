import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StrengthIcon } from '@/components';
import { RpeBadge } from '@/components/ui';
import { parseLocalDate } from '@/lib/dates';
import type { StrengthSession } from '@/types';

export function SessionRow({
  session,
  onView,
  onDelete,
}: {
  session: StrengthSession;
  onView: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 sm:gap-4 p-2 sm:p-3 rounded',
        'bg-abyss/50 border border-text-muted/10',
        'hover:border-neon-cyan/30 transition-all cursor-pointer'
      )}
      onClick={onView}
    >
      <StrengthIcon size="md" className="text-warning-orange" />
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-sans text-text-primary">
            {parseLocalDate(session.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
          </span>
          <span className="text-text-muted">—</span>
          <span className="text-sm font-sans text-text-secondary">{session.name || 'Séance'}</span>
        </div>
        <div className="flex flex-wrap gap-x-3 text-xs font-sans text-text-muted mt-1">
          {session.duration_min ? <span>{session.duration_min} min</span> : null}
          <span>{(session.total_volume / 1000).toFixed(1)}k kg</span>
          <span>{session.total_sets} séries</span>
        </div>
      </div>
      <RpeBadge rpe={session.overall_rpe} />
      <button
        type="button"
        title="Supprimer la séance"
        aria-label="Supprimer la séance"
        className="p-1 rounded text-text-muted hover:text-danger-red hover:bg-danger-red/10"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
