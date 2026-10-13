import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { analyticsApi } from '@/lib/api';
import { coachApi, coachTodayKey } from '@/lib/coachToday';
import { readFlag, writeFlag } from '@/lib/install';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/** Borg CR-10 wording; only both ends are written under the chips. */
const RPE_LABELS = [
  'très facile',
  'facile',
  'modéré',
  'un peu dur',
  'dur',
  'dur +',
  'très dur',
  'très dur +',
  'extrêmement dur',
  'maximal',
] as const;

const DISMISSED_KEY = 'arete.rpe.dismissed';
const MAX_REMEMBERED = 30;

function dismissed(): number[] {
  return (readFlag(DISMISSED_KEY) ?? '').split(',').filter(Boolean).map(Number);
}

/**
 * One-tap RPE for a cardio session that has none, saved through the existing
 * session PATCH. Hidden once saved, once dismissed (remembered per session),
 * and while the coach's own follow-up already asks about this session.
 */
export function RpePicker({ sessionId, autoFocus = false, className }: { sessionId: number; autoFocus?: boolean; className?: string }) {
  const queryClient = useQueryClient();
  const firstChip = useRef<HTMLButtonElement>(null);
  const [hidden, setHidden] = useState(() => dismissed().includes(sessionId));
  // Read the dashboard's follow-ups from cache only: no extra request here.
  const { data: coach } = useQuery({ queryKey: coachTodayKey, queryFn: coachApi.today, enabled: false });
  const askedByCoach = coach?.items.some(
    (item) => item.kind === 'followup' && item.record.session_id === sessionId && item.record.state === 'pending',
  );
  const save = useMutation({
    mutationFn: (rpe: number) => analyticsApi.updateSession(sessionId, { rpe }),
    onSuccess: () => {
      setHidden(true);
      // The dashboard's refresh brings the coach card back with it.
      invalidateAfterSession(queryClient);
    },
  });

  const visible = !hidden && !askedByCoach;
  useEffect(() => {
    if (!autoFocus || !visible) return;
    firstChip.current?.scrollIntoView?.({ block: 'center' });
    firstChip.current?.focus({ preventScroll: true });
  }, [autoFocus, visible]);

  if (!visible) return null;
  const dismiss = () => {
    writeFlag(DISMISSED_KEY, [...dismissed(), sessionId].slice(-MAX_REMEMBERED).join(','));
    setHidden(true);
  };

  return (
    <section
      aria-label="Effort ressenti"
      className={cn('rounded-lg border border-neon-cyan/25 bg-neon-cyan/5 p-3', className)}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-sm text-text-primary">Comment l’as-tu ressentie ? Effort de 1 à 10.</p>
        <button type="button" onClick={dismiss} aria-label="Ne pas noter cette séance" className="rounded p-1 hover:bg-text-muted/20">
          <X className="size-4 text-text-muted" />
        </button>
      </div>
      <div role="group" aria-label="RPE de 1 à 10" className="grid grid-cols-10 gap-1">
        {RPE_LABELS.map((label, index) => (
          <button
            key={label}
            ref={index === 0 ? firstChip : undefined}
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(index + 1)}
            aria-label={`${index + 1} — ${label}`}
            title={label}
            className="min-h-10 rounded border border-text-muted/25 bg-abyss text-sm font-sans text-text-secondary hover:border-neon-cyan hover:text-neon-cyan focus-visible:outline focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:opacity-40"
          >
            {index + 1}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-text-muted">
        <span>{RPE_LABELS[0]}</span>
        <span>{RPE_LABELS[9]}</span>
      </div>
      {save.isError && <p role="alert" className="mt-1 text-xs text-danger-red">Enregistrement impossible, réessaie.</p>}
    </section>
  );
}
