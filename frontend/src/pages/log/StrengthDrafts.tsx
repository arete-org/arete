import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dumbbell } from 'lucide-react';
import { Button, Panel } from '@/components/ui';
import { strengthApi } from '@/lib/api';
import { parseLocalDate } from '@/lib/dates';
import { qk } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';
import type { StrengthDraft } from '@/types';

const MAX_NAMES = 3;

/** What Garmin recognised, in a line: « Développé couché · Squat · +2 ». */
function draftSummary(draft: StrengthDraft): string {
  const names = draft.exercises.map((e) => e.name);
  if (names.length === 0) return 'Exercices à saisir';
  const shown = names.slice(0, MAX_NAMES).join(' · ');
  return names.length > MAX_NAMES ? `${shown} · +${names.length - MAX_NAMES}` : shown;
}

/** Garmin strength sessions awaiting their loads, first thing in the Journal. */
export function StrengthDrafts({ drafts, onComplete }: { drafts: StrengthDraft[]; onComplete: (id: number) => void }) {
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (id: number) => strengthApi.dismissDraft(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.strengthDrafts }),
  });
  if (drafts.length === 0) return null;
  return (
    <section aria-labelledby="drafts-title" className="mb-4 sm:mb-6">
      <Panel
        title={<span id="drafts-title">À COMPLÉTER ({drafts.length})</span>}
        titleTone="text-neon-gold"
        animate={false}
      >
        <p className="text-xs font-sans text-text-muted -mt-2 mb-3">
          Ta montre a compté les séries, pas les kilos. Ajoute-les pour suivre tes records et ta progression.
        </p>
        <ul className="space-y-2">
          {drafts.map((draft) => {
            const day = parseLocalDate(draft.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
            return (
              <li
                key={draft.id}
                className="p-3 rounded border border-neon-gold/30 bg-neon-gold/5 flex flex-wrap items-center gap-x-3 gap-y-2"
              >
                <Dumbbell className="w-4 h-4 text-warning-orange shrink-0" aria-hidden />
                <div className="flex-1 min-w-[12rem]">
                  <p className="text-sm font-sans text-text-primary truncate">
                    {day} — {draft.name || 'Séance de force'}
                    {draft.duration_min ? <span className="text-text-muted"> · {draft.duration_min} min</span> : null}
                  </p>
                  <p className="text-xs font-sans text-text-muted truncate">{draftSummary(draft)}</p>
                </div>
                <div className="flex items-center gap-1 ml-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11"
                    aria-label={`Ignorer la séance du ${day}`}
                    loading={dismiss.isPending && dismiss.variables === draft.id}
                    onClick={() => dismiss.mutate(draft.id)}
                  >
                    Ignorer
                  </Button>
                  <Button variant="gold" strong size="sm" className="min-h-11" onClick={() => onComplete(draft.id)}>
                    Ajoute tes charges
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {dismiss.isError && (
          <p role="alert" className="mt-2 text-xs font-sans text-danger-red">
            {readableError(dismiss.error)}
          </p>
        )}
      </Panel>
    </section>
  );
}
