import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dumbbell } from 'lucide-react';
import { Button, Panel } from '@/components/ui';
import { strengthApi } from '@/lib/api';
import { parseLocalDate } from '@/lib/dates';
import { qk } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';
import type { StrengthDraft } from '@/types';

const MAX_NAMES = 3;

/** What the watch recognised, in a line: « Développé couché · Squat · +2 ». */
function draftSummary(draft: StrengthDraft): string {
  const names = draft.exercises.map((e) => e.name);
  if (names.length === 0) return 'Exercices à saisir';
  const shown = names.slice(0, MAX_NAMES).join(' · ');
  return names.length > MAX_NAMES ? `${shown} · +${names.length - MAX_NAMES}` : shown;
}

interface StrengthDraftsProps {
  drafts: StrengthDraft[];
  /** How many wait in all; the list shows the newest page. */
  total: number;
  onComplete: (id: number) => void;
  /** True while a draft's screen is open: focus moves only once it closes. */
  paused: boolean;
}

/** Strength sessions awaiting their loads, first thing in the Journal. */
export function StrengthDrafts({ drafts, total, onComplete, paused }: StrengthDraftsProps) {
  const queryClient = useQueryClient();
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  // The row acted on: once it leaves the list, focus goes to the next one or the heading.
  const acted = useRef<{ id: number; index: number } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.strengthDrafts });
  const dismiss = useMutation({ mutationFn: (id: number) => strengthApi.dismissDraft(id), onSettled: refresh });
  const dismissAll = useMutation({ mutationFn: () => strengthApi.dismissAllDrafts(), onSettled: refresh });
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    const row = acted.current;
    // Still listed: not saved yet (the modal gave its button back) or the list not refreshed yet.
    if (paused || row === null || drafts.some((d) => d.id === row.id)) return;
    acted.current = null;
    const next = section.current?.querySelectorAll<HTMLButtonElement>('[data-draft-action]')[row.index];
    (next ?? heading.current)?.focus();
  }, [drafts, paused]);

  if (drafts.length === 0) return null;
  const error = dismiss.error ?? dismissAll.error;
  return (
    <section ref={section} aria-labelledby="drafts-title" className="mb-4 sm:mb-6">
      <Panel
        title={
          <span ref={heading} id="drafts-title" tabIndex={-1} className="outline-none">
            À COMPLÉTER ({total})
          </span>
        }
        titleTone="text-neon-gold"
        animate={false}
      >
        <p className="text-xs font-sans text-text-muted -mt-2 mb-3">
          Arete ne reçoit pas tes charges. Ajoute-les pour suivre tes records et ta progression.
        </p>
        <ul className="space-y-2">
          {drafts.map((draft, index) => {
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
                    onClick={() => {
                      acted.current = { id: draft.id, index };
                      dismiss.mutate(draft.id);
                    }}
                  >
                    Ignorer
                  </Button>
                  <Button
                    variant="gold"
                    strong
                    size="sm"
                    className="min-h-11"
                    data-draft-action
                    onClick={() => {
                      acted.current = { id: draft.id, index };
                      onComplete(draft.id);
                    }}
                  >
                    Ajoute tes charges
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {total > drafts.length && (
          <p className="mt-2 text-xs font-sans text-text-muted">
            Les {drafts.length} plus récentes sur {total}.
          </p>
        )}
        {total > 1 && !confirmAll && (
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setConfirmAll(true)}>
              Tout ignorer
            </Button>
          </div>
        )}
        {total > 1 && confirmAll && (
          <div role="group" aria-labelledby="drafts-confirm" className="mt-2 p-3 rounded border border-text-muted/20 space-y-2">
            <p id="drafts-confirm" className="text-sm font-sans text-text-secondary">
              Ignorer les {total} séances à compléter ? Tu pourras en rouvrir une depuis la séance.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setConfirmAll(false)}>
                Annuler
              </Button>
              <Button
                variant="danger"
                size="sm"
                className="min-h-11"
                loading={dismissAll.isPending}
                onClick={() => dismissAll.mutate(undefined, { onSettled: () => setConfirmAll(false) })}
              >
                Ignorer les {total}
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs font-sans text-danger-red">
            {readableError(error)}
          </p>
        )}
      </Panel>
    </section>
  );
}
