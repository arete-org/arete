import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, ChevronDown } from 'lucide-react';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { Button, Modal, ModalHeader } from '@/components/ui';
import { goalsApi } from '@/lib/api';
import { parseLocalDate } from '@/lib/dates';
import { LEVEL_LABEL, PLAN_KIND_LABEL, phaseLabel } from '@/lib/fr';
import { invalidateAfterSession, qk } from '@/lib/queryKeys';
import { formatKm } from '@/lib/race';
import { readableError } from '@/lib/utils';
import type { Goal, PlanPhase, PlanPreview, PlanSessionDraft, PlanWeek } from '@/types';

const PHASE_TONE: Record<PlanPhase, string> = {
  base: 'text-neon-cyan',
  build: 'text-neon-purple',
  specific: 'text-warning-orange',
  taper: 'text-success-green',
  race: 'text-neon-gold',
};
const WEEKDAYS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];

const shortDate = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

function weekEnd(start: string): string {
  const end = parseLocalDate(start);
  end.setDate(end.getDate() + 6);
  return end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A Hyrox or hybrid session by its kind ("Course clé"), any other by its type ("Fractionné"). */
function sessionLabel(s: PlanSessionDraft): string {
  if (s.kind && PLAN_KIND_LABEL[s.kind]) return capitalized(PLAN_KIND_LABEL[s.kind]);
  return SESSION_TYPE_LABEL[s.session_type] ?? s.session_type;
}

/** One collapsible row per week; its sessions open on demand. */
export function PlanWeekList({ weeks }: { weeks: PlanWeek[] }) {
  return (
    <ol className="space-y-1.5">
      {weeks.map((week) => (
        <li key={week.start}>
          <details className="rounded border border-text-muted/20 bg-abyss/50 group">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-sans">
              <span className="text-text-secondary">
                {shortDate(week.start)} – {weekEnd(week.start)}
              </span>
              <span className={PHASE_TONE[week.phase]}>{phaseLabel(week.phase)}</span>
              <span className="text-text-primary">{week.minutes} min</span>
              {week.recovery && <span className="text-success-green">allégée</span>}
              {week.dropped && week.dropped.length > 0 && (
                <span className="text-warning-orange">{plural(week.dropped.length, 'séance retirée', 'séances retirées')}</span>
              )}
              <span className="ml-auto inline-flex items-center gap-1 text-text-muted">
                {week.sessions.length} séance{week.sessions.length > 1 ? 's' : ''}
                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <ul className="border-t border-text-muted/10 px-3 py-2 space-y-1.5">
              {week.sessions.map((s, i) => (
                <li key={`${s.date}-${i}`} className="text-xs">
                  <span className="font-sans text-text-muted mr-2">
                    {parseLocalDate(s.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })}
                  </span>
                  <span className="text-text-primary">{sessionLabel(s)}</span>
                  {s.tags?.includes('kept') && <span className="font-sans text-neon-gold"> · gardée</span>}
                  {s.duration_min != null && <span className="font-sans text-text-secondary"> · {s.duration_min} min</span>}
                  {s.distance_km != null && <span className="font-sans text-text-secondary"> · {formatKm(s.distance_km)} km</span>}
                  {s.hr_zone && <span className="font-sans text-neon-cyan"> · {s.hr_zone}</span>}
                  {s.description && <p className="text-text-muted mt-0.5">{s.description}</p>}
                </li>
              ))}
              {week.dropped?.map((message, i) => (
                <li key={`dropped-${i}`} className="text-xs text-warning-orange">
                  {message}
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ol>
  );
}

const restDays = (days: number[]) => (days.length > 0 ? ` · repos ${days.map((d) => WEEKDAYS[d]).join(', ')}` : '');
const vdot = (value: number | null) => (value != null ? ` · VDOT ${value.toLocaleString('fr-FR')}` : '');

/**
 * What a Hyrox or hybrid plan is built from and how its weeks run: the
 * athlete's level and days, a first lighter week, the structure per phase,
 * then the sessions the athlete edited, which regeneration keeps.
 */
export function HybridPlanOverview({ preview }: { preview: PlanPreview }) {
  const { inputs, summary = [] } = preview;
  const kept = inputs.kept ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs font-sans text-text-muted">
        {inputs.level && `Niveau ${LEVEL_LABEL[inputs.level] ?? inputs.level} · `}
        {inputs.training_days != null && `${inputs.training_days} jours d’entraînement/sem · `}
        {inputs.sessions_per_week} séances/sem · course actuelle {inputs.weekly_minutes_now} min/sem
        {restDays(inputs.rest_days)}
        {vdot(inputs.vdot)}
      </p>
      {inputs.deload && (
        <p role="note" className="ui-inset px-3 py-2 text-xs text-success-green">
          Ta charge récente est élevée : le plan commence par une semaine allégée.
        </p>
      )}
      {summary.length > 0 && (
        <section aria-label="Structure de la semaine" className="space-y-1">
          <h3 className="text-xs font-sans text-text-muted uppercase">Structure de la semaine</h3>
          <ul className="space-y-1">
            {summary.map((line) => (
              <li key={line} className="text-xs text-text-secondary">
                {line}
              </li>
            ))}
          </ul>
        </section>
      )}
      {kept.length > 0 && (
        <section aria-label="Séances modifiées" className="space-y-1">
          <h3 className="text-xs font-sans text-neon-gold">Séances que tu as modifiées : gardées</h3>
          <ul className="space-y-1">
            {kept.map((k, i) => (
              <li key={`${k.date}-${i}`} className="text-xs text-text-secondary">
                <span className="font-sans text-text-muted mr-2">
                  {parseLocalDate(k.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}
                </span>
                {k.description}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Preview of the goal's plan; writing and deleting it act at once. */
export function PlanPreviewModal({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: qk.planPreview(goal.id),
    queryFn: () => goalsApi.previewPlan(goal.id),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const write = useMutation({
    mutationFn: () => goalsApi.writePlan(goal.id),
    onSuccess: () => invalidateAfterSession(queryClient),
  });
  const remove = useMutation({
    mutationFn: () => goalsApi.deletePlan(goal.id),
    onSuccess: () => {
      setConfirmDelete(false);
      invalidateAfterSession(queryClient);
    },
  });
  const busy = write.isPending || remove.isPending;
  const inputs = preview.data?.inputs;
  const hybrid = goal.goal_type === 'hyrox' || goal.goal_type === 'hybrid';

  return createPortal(
    <Modal
      open
      onClose={() => !busy && onClose()}
      label={`Plan vers ${goal.name}`}
      className="max-w-2xl max-h-[90dvh] overflow-y-auto p-4 sm:p-6"
    >
      <ModalHeader
        title={`PLAN · ${goal.name}`}
        icon={<CalendarRange className="w-5 h-5" />}
        tone="text-neon-purple"
        onClose={busy ? undefined : onClose}
        className="mb-4"
      />

      {preview.isLoading && <p className="text-sm text-text-muted">Calcul du plan…</p>}
      {preview.isError && (
        <p role="alert" className="text-sm text-danger-red">
          {readableError(preview.error)}
        </p>
      )}

      {preview.data && inputs && (
        <div className="space-y-4">
          {hybrid ? (
            <HybridPlanOverview preview={preview.data} />
          ) : (
            <p className="text-xs font-sans text-text-muted">
              Départ : {inputs.weekly_minutes_now} min/sem · {inputs.sessions_per_week} séances/sem
              {restDays(inputs.rest_days)}
              {vdot(inputs.vdot)}
            </p>
          )}
          <PlanWeekList weeks={preview.data.weeks} />
        </div>
      )}

      {write.data && (
        <div role="status" className="mt-4 rounded border border-success-green/30 bg-success-green/5 p-3 text-xs space-y-1">
          <p className="text-success-green">
            {write.data.created} séance{write.data.created > 1 ? 's' : ''} écrite{write.data.created > 1 ? 's' : ''}
            {write.data.replaced > 0 && ` · ${write.data.replaced} remplacée${write.data.replaced > 1 ? 's' : ''}`}
          </p>
          {write.data.skipped_days.length > 0 && (
            <p className="text-text-muted">
              Jours déjà occupés, laissés tels quels : {write.data.skipped_days.map(shortDate).join(', ')}
            </p>
          )}
        </div>
      )}
      {remove.data && (
        <p role="status" className="mt-4 text-xs text-text-muted">
          {remove.data.deleted} séance{remove.data.deleted > 1 ? 's' : ''} à venir supprimée
          {remove.data.deleted > 1 ? 's' : ''}.
        </p>
      )}
      {(write.isError || remove.isError) && (
        <p role="alert" className="mt-4 text-xs text-danger-red">
          {readableError(write.error ?? remove.error)}
        </p>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {confirmDelete ? (
          <>
            <span className="text-xs text-text-muted self-center">Supprimer les séances à venir de ce plan ?</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Annuler
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              onClick={() => {
                write.reset();
                remove.mutate();
              }}
            >
              Confirmer
            </Button>
          </>
        ) : (
          <>
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)} disabled={busy}>
              Supprimer le plan
            </Button>
            <Button
              variant="purple"
              strong
              size="sm"
              loading={write.isPending}
              disabled={!preview.data || busy}
              onClick={() => {
                remove.reset();
                write.mutate();
              }}
            >
              Écrire le plan
            </Button>
          </>
        )}
      </div>
    </Modal>,
    document.body
  );
}
