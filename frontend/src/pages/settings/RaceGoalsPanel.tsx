import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Flag, Plus, Trash2 } from 'lucide-react';
import { Button, Field, Input, Modal, ModalHeader, Panel } from '@/components/ui';
import { goalsApi } from '@/lib/api';
import { parseLocalDate, toLocalISODate } from '@/lib/dates';
import { invalidateAfterSession, invalidateWithDashboard, qk } from '@/lib/queryKeys';
import { formatKm, formatRaceTime, parseRaceTime } from '@/lib/race';
import { cn, readableError } from '@/lib/utils';
import type { Goal, GoalPriority, GoalStatus } from '@/types';
import { PlanPreviewModal } from './PlanPreviewModal';

const DISTANCES = [5, 10, 21.1, 42.195];
const PRIORITIES: { value: GoalPriority; hint: string }[] = [
  { value: 'A', hint: 'Course principale' },
  { value: 'B', hint: 'Course importante' },
  { value: 'C', hint: 'Course de préparation' },
];
const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'active',
  done: 'courue',
  cancelled: 'annulée',
};

const CHIP = 'px-3 py-1.5 rounded text-xs font-sans transition-all border';
const CHIP_IDLE = 'bg-abyss border-text-muted/30 text-text-muted hover:border-text-muted/50';
const CHIP_ON = 'bg-neon-cyan/20 border-neon-cyan/50 text-neon-cyan';

/** 21.1 from "21,1"; null outside the server's 1–250 km. */
function parseKm(text: string): number | null {
  const km = Number(text.trim().replace(',', '.'));
  return text.trim() && km >= 1 && km <= 250 ? km : null;
}

function GoalForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [raceDate, setRaceDate] = useState('');
  const [distance, setDistance] = useState('');
  const [target, setTarget] = useState('');
  const [priority, setPriority] = useState<GoalPriority>('A');
  const [invalid, setInvalid] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: goalsApi.create,
    onSuccess: () => {
      invalidateWithDashboard(queryClient, qk.goals, qk.formCurve());
      onDone();
    },
  });

  const submit = () => {
    const km = parseKm(distance);
    const targetSec = target.trim() ? parseRaceTime(target) : null;
    if (!name.trim() || !raceDate) return setInvalid('Nom et date de course requis.');
    if (km == null) return setInvalid('Distance entre 1 et 250 km.');
    if (target.trim() && targetSec == null) return setInvalid('Temps visé au format h:mm:ss.');
    setInvalid(null);
    create.mutate({ name: name.trim(), race_date: raceDate, distance_km: km, target_time_sec: targetSec, priority });
  };

  const km = parseKm(distance);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3 border-t border-text-muted/10 pt-3"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Nom de la course" gap="sm">
          <Input value={name} maxLength={120} placeholder="Semi de Paris" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Date" gap="sm">
          <Input type="date" min={toLocalISODate()} value={raceDate} onChange={(e) => setRaceDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Distance (km)" gap="sm">
        <div className="flex flex-wrap items-center gap-2">
          {DISTANCES.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={km === d}
              onClick={() => setDistance(formatKm(d))}
              className={cn(CHIP, km === d ? CHIP_ON : CHIP_IDLE)}
            >
              {formatKm(d)}
            </button>
          ))}
          <Input
            inputMode="decimal"
            aria-label="Distance libre en km"
            placeholder="15"
            value={distance}
            onChange={(e) => setDistance(e.target.value)}
            className="w-24"
          />
        </div>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Temps visé (facultatif)" hint="Format h:mm:ss" gap="sm">
          <Input inputMode="numeric" placeholder="1:45:00" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field label="Priorité" gap="sm">
          <div className="flex gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                title={p.hint}
                aria-pressed={priority === p.value}
                onClick={() => setPriority(p.value)}
                className={cn(CHIP, 'w-10', priority === p.value ? CHIP_ON : CHIP_IDLE)}
              >
                {p.value}
              </button>
            ))}
          </div>
        </Field>
      </div>
      {(invalid || create.isError) && (
        <p role="alert" className="text-xs font-sans text-danger-red">
          {invalid ?? readableError(create.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Annuler
        </Button>
        <Button type="submit" size="sm" loading={create.isPending}>
          Ajouter la course
        </Button>
      </div>
    </form>
  );
}

function GoalRow({ goal, onPlan, onDelete }: { goal: Goal; onPlan: () => void; onDelete: () => void }) {
  return (
    <li className={cn('rounded border border-text-muted/20 p-3 space-y-2', goal.status !== 'active' && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-text-primary truncate">
            <span className="font-sans text-neon-gold mr-2" title="Priorité">
              {goal.priority}
            </span>
            {goal.name}
          </p>
          <p className="text-xs font-sans text-text-muted">
            {parseLocalDate(goal.race_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
            {' · '}
            {formatKm(goal.distance_km)} km
            {goal.target_time_sec != null && ` · objectif ${formatRaceTime(goal.target_time_sec)}`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-sans text-neon-cyan">{goal.days_left > 0 ? `J-${goal.days_left}` : 'Jour J'}</p>
          <p className="text-[11px] font-sans text-text-muted">{STATUS_LABEL[goal.status]}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="purple" size="sm" onClick={onPlan} disabled={goal.status !== 'active'}>
          <CalendarRange className="size-3.5" /> Générer le plan
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Supprimer ${goal.name}`}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

/** Race goals; they act at once, apart from the settings form's save button. */
export function RaceGoalsPanel() {
  const queryClient = useQueryClient();
  const goals = useQuery({ queryKey: qk.goalList, queryFn: () => goalsApi.list() });
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<Goal | null>(null);
  const [planFor, setPlanFor] = useState<Goal | null>(null);

  const remove = useMutation({
    mutationFn: (id: number) => goalsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.goals });
      // The goal's future generated sessions go with it.
      invalidateAfterSession(queryClient);
      setToDelete(null);
    },
  });
  const closeDelete = () => {
    setToDelete(null);
    remove.reset();
  };

  return (
    <Panel
      variant="inset"
      title={
        <span className="flex items-center gap-2">
          <Flag className="size-4 text-neon-gold" /> Course objectif
        </span>
      }
    >
      <div className="space-y-3">
        {goals.isLoading && <p className="text-sm text-text-muted">Chargement des courses…</p>}
        {goals.isError && <p className="text-sm text-danger-red">Courses indisponibles.</p>}
        {goals.data?.length === 0 && !adding && (
          <p className="text-sm text-text-muted">
            Aucune course prévue. Ajoute-en une pour construire un plan jusqu’au jour J.
          </p>
        )}
        {goals.data && goals.data.length > 0 && (
          <ul className="space-y-2">
            {goals.data.map((goal) => (
              <GoalRow key={goal.id} goal={goal} onPlan={() => setPlanFor(goal)} onDelete={() => setToDelete(goal)} />
            ))}
          </ul>
        )}
        {adding ? (
          <GoalForm onDone={() => setAdding(false)} />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Ajouter une course
          </Button>
        )}
      </div>

      {/* The settings tab is a transformed, blurred panel: a fixed overlay must leave it. */}
      {createPortal(
        <Modal open={toDelete !== null} onClose={closeDelete} className="max-w-sm p-4 sm:p-6">
          <ModalHeader title="SUPPRIMER LA COURSE" onClose={closeDelete} className="mb-4" />
          <p className="text-sm text-text-secondary mb-2">Supprimer « {toDelete?.name} » ?</p>
          <p className="text-xs text-text-muted mb-6">Les séances à venir générées pour cette course sont supprimées aussi.</p>
          {remove.isError && <p className="text-xs text-danger-red mb-3">{readableError(remove.error)}</p>}
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" onClick={closeDelete}>
              Annuler
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => toDelete && remove.mutate(toDelete.id)}>
              Supprimer
            </Button>
          </div>
        </Modal>,
        document.body
      )}

      {planFor && <PlanPreviewModal key={planFor.id} goal={planFor} onClose={() => setPlanFor(null)} />}
    </Panel>
  );
}
