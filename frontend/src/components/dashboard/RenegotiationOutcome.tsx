import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';
import { DecisionBadge } from '@/components/DecisionBadge';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { planApi } from '@/lib/api';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { dayLabel, garminLine, type DayOutcome } from '@/lib/renegotiation';
import { readableError } from '@/lib/utils';
import type { PlanDecision, RenegotiationGarmin } from '@/types';

/**
 * The written change, then Garmin's outcome apart: a Garmin failure never
 * reads as a failed choice. It takes the focus when it appears, the control
 * that was focused having just left.
 */
export function RenegotiationOutcome({ outcome, onDismiss }: { outcome: DayOutcome; onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), [outcome]);
  const garmin = garminLine(outcome);
  const warn = outcome.garmin !== 'sent' && outcome.garmin !== 'withdrawn';
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="status"
      className="flex items-start gap-2 rounded-lg border border-success-green/30 bg-success-green/5 px-3 py-2 text-xs font-sans focus:outline-none focus-visible:outline-2 focus-visible:outline-neon-cyan"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-text-primary">{outcome.headline}</p>
        {garmin && <p className={warn ? 'text-warning-orange' : 'text-success-green/90'}>{garmin}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Fermer ce message"
        className="-my-2 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center text-text-muted hover:text-text-primary"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}

/** A session moved away from today: its reason, and « Rétablir » brings it back. */
export function MovedSession({
  decision,
  onReverted,
}: {
  decision: PlanDecision;
  /** Back today: the panel reports it, with Garmin's part, and takes the focus. */
  onReverted: (garmin: RenegotiationGarmin | undefined) => void;
}) {
  const client = useQueryClient();
  const revert = useMutation({
    mutationFn: () => planApi.revert(decision.id),
    onSuccess: (reverted) => onReverted(reverted.garmin),
    // 409: reverted elsewhere, or the session changed since (its message says so); a refetch shows it.
    onSettled: () => invalidateAfterSession(client),
  });
  const type = String(decision.original?.session_type ?? '');
  const to = typeof decision.adapted?.date === 'string' ? decision.adapted.date : null;
  return (
    <div className="rounded-lg border border-text-muted/20 bg-void/40 px-3 py-2 text-[11px] font-sans">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <DecisionBadge decision="move" />
        <span className="text-xs text-text-primary">{SESSION_TYPE_LABEL[type] ?? type}</span>
        {to && <span className="text-text-muted">→ {dayLabel(to)}</span>}
      </div>
      <p className="mt-1 text-text-secondary">{decision.reason}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3">
        <button
          type="button"
          aria-disabled={revert.isPending}
          onClick={() => {
            if (!revert.isPending) revert.mutate();
          }}
          className="inline-flex min-h-11 items-center gap-1 text-text-muted hover:text-text-primary aria-disabled:opacity-40"
        >
          <RotateCcw aria-hidden className="h-3 w-3" />
          Rétablir la séance prévue
        </button>
        {revert.error && <span className="text-danger-red">{readableError(revert.error)}</span>}
      </div>
    </div>
  );
}
