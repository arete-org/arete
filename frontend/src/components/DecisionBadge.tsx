import { DECISION_LABEL } from '@/lib/fr';
import { cn } from '@/lib/utils';
import type { PlanDecisionKind } from '@/types';

const DECISION_TONE: Record<PlanDecisionKind, string> = {
  keep: 'text-success-green border-success-green/40',
  ease: 'text-neon-gold border-neon-gold/40',
  replace_easy: 'text-warning-orange border-warning-orange/40',
  rest: 'text-danger-red border-danger-red/40',
};

/** What the morning adaptation did to a planned session; struck through once reverted. */
export function DecisionBadge({ decision, reverted = false }: { decision: PlanDecisionKind; reverted?: boolean }) {
  return (
    <span
      className={cn(
        'border rounded px-1.5 py-0.5 text-[11px] font-sans',
        reverted ? 'text-text-muted border-text-muted/30 line-through' : DECISION_TONE[decision]
      )}
      title={reverted ? 'Décision annulée : séance prévue rétablie' : undefined}
    >
      {DECISION_LABEL[decision]}
    </span>
  );
}
