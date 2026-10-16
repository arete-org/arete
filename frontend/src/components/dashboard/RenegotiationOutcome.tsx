import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';
import { DecisionBadge } from '@/components/DecisionBadge';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { planApi } from '@/lib/api';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';
import type { PlanDecision, RenegotiationGarmin } from '@/types';
import type { Renegotiation } from './RenegotiateMenu';

/** « jeudi 22 octobre », from an ISO day read at noon (no zone shifts it). */
const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Garmin's part, as the server reported it; nothing when Garmin held no copy. */
const GARMIN_LINE: Record<RenegotiationGarmin, string | null> = {
  sent: 'Garmin : la séance est à jour sur ta montre.',
  withdrawn: 'Garmin : la séance est retirée de ta montre.',
  failed: 'Garmin n’a pas confirmé la mise à jour, rien n’est renvoyé automatiquement : vérifie dans le Planning.',
  not_started: 'Garmin n’a pas été mis à jour à temps : renvoie la séance depuis le Planning.',
  unchanged: null,
  disabled: 'Envoi automatique vers Garmin désactivé : si ta montre avait la séance, renvoie-la depuis le Planning.',
  disconnected: 'Garmin n’est pas connecté : ta montre n’a pas été mise à jour.',
};

function headline({ result, option }: Renegotiation): string {
  switch (result.decision.decision) {
    case 'move':
      return `Séance déplacée à ${dayLabel(result.date)}.`;
    case 'rest':
      return 'Repos noté pour aujourd’hui.';
    default:
      return `Séance modifiée : ${option.detail}.`;
  }
}

/**
 * The written choice, then Garmin's outcome apart: a Garmin failure never
 * reads as a failed choice. It takes the focus when it appears, the menu
 * that was focused having just left.
 */
export function RenegotiationOutcome({ done, onDismiss }: { done: Renegotiation; onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), [done]);
  const garmin = GARMIN_LINE[done.result.garmin];
  const warn = done.result.garmin !== 'sent' && done.result.garmin !== 'withdrawn';
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="status"
      className="flex items-start gap-2 rounded-lg border border-success-green/30 bg-success-green/5 px-3 py-2 text-xs font-sans focus:outline-none focus-visible:outline-2 focus-visible:outline-neon-cyan"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-text-primary">{headline(done)}</p>
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
export function MovedSession({ decision, onReverted }: { decision: PlanDecision; onReverted: () => void }) {
  const client = useQueryClient();
  const revert = useMutation({
    mutationFn: () => planApi.revert(decision.id),
    onSuccess: onReverted,
    // 409 means it was already reverted elsewhere: a refetch shows it.
    onSettled: () => invalidateAfterSession(client),
  });
  const type = String(decision.original?.session_type ?? '');
  const to = typeof decision.adapted?.date === 'string' ? decision.adapted.date : null;
  return (
    <div className="rounded-lg border border-text-muted/20 bg-void/40 px-3 py-2 text-[11px] font-sans">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <DecisionBadge decision="move" />
        <span className="text-xs uppercase tracking-wider text-text-primary">{SESSION_TYPE_LABEL[type] ?? type}</span>
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
