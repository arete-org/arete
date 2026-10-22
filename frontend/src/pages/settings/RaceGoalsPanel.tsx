import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Flag, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button, Field, Input, Modal, ModalHeader, Panel } from '@/components/ui';
import { goalsApi } from '@/lib/api';
import { toLocalISODate } from '@/lib/dates';
import { keptEditsText } from '@/lib/fr';
import { invalidateAfterSession, invalidateWithDashboard, qk } from '@/lib/queryKeys';
import {
  addDays,
  blockStart,
  formatKm,
  formatRaceTime,
  hybridEnd,
  hyroxLabel,
  longDate,
  parseRaceTime,
  resizedBlockEnd,
} from '@/lib/race';
import { cn, readableError } from '@/lib/utils';
import type { Goal, GoalDetails, GoalPriority, GoalStatus, GoalType, HyroxEquipment } from '@/types';
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
const GOAL_TYPES: { value: GoalType; label: string }[] = [
  { value: 'race', label: 'Course' },
  { value: 'hyrox', label: 'Hyrox' },
  { value: 'hybrid', label: 'Bloc hybride' },
];
const DIVISIONS: { value: GoalDetails['division']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'pro', label: 'Pro' },
];
const FORMATS: { value: GoalDetails['format']; label: string }[] = [
  { value: 'solo', label: 'Solo' },
  { value: 'doubles', label: 'Duo' },
];
const CATEGORIES: { value: NonNullable<GoalDetails['category']>; label: string }[] = [
  { value: 'men', label: 'Hommes' },
  { value: 'women', label: 'Femmes' },
  { value: 'mixed', label: 'Mixte' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));
const EQUIPMENT: { value: HyroxEquipment; label: string }[] = [
  { value: 'sled', label: 'Traîneau (poussée et tirage)' },
  { value: 'ski_erg', label: 'SkiErg' },
  { value: 'rower', label: 'Rameur' },
  { value: 'wall_ball', label: 'Wall ball' },
];
const BLOCK_WEEKS = [8, 12] as const;
/** A running block's end may move this many weeks later (services/goals.py). */
const POSTPONE_WEEKS = [0, 1, 2];
const SUBMIT_LABEL: Record<GoalType, string> = {
  race: 'Ajouter la course',
  hyrox: 'Ajouter le Hyrox',
  hybrid: 'Créer le bloc',
};

const CHIP = 'px-3 py-1.5 rounded text-xs font-sans transition-all border disabled:opacity-40 disabled:cursor-not-allowed';
const CHIP_IDLE = 'bg-abyss border-text-muted/30 text-text-muted hover:border-text-muted/50';
const CHIP_ON = 'bg-neon-cyan/20 border-neon-cyan/50 text-neon-cyan';

type Equipment = GoalDetails['equipment'];

/** 21.1 from "21,1"; null outside the server's 1–250 km. */
function parseKm(text: string): number | null {
  const km = Number(text.trim().replace(',', '.'));
  return text.trim() && km >= 1 && km <= 250 ? km : null;
}

/** "Aucun" excludes the rest; an empty choice is "Aucun". Kept in display order. */
function toggleEquipment(current: Equipment, item: HyroxEquipment | 'none'): Equipment {
  if (item === 'none') return ['none'];
  const chosen = current.includes(item) ? current.filter((e) => e !== item) : [...current, item];
  const ordered = EQUIPMENT.map((e) => e.value).filter((e) => chosen.includes(e));
  return ordered.length ? ordered : ['none'];
}

/** A block whose first Monday has come: its length is fixed, its end moves later only. */
function blockStarted(goal: Goal, today: string): boolean {
  const weeks = goal.details?.weeks ?? 12;
  return blockStart(goal.race_date, weeks) <= today;
}

/** A row of mutually exclusive chips. */
function Chips<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: T; label: string; title?: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: (value: T) => boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          disabled={disabled?.(o.value)}
          onClick={() => onChange(o.value)}
          className={cn(CHIP, value === o.value ? CHIP_ON : CHIP_IDLE)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EquipmentChips({ value, onChange }: { value: Equipment; onChange: (value: Equipment) => void }) {
  const options: { value: HyroxEquipment | 'none'; label: string }[] = [...EQUIPMENT, { value: 'none', label: 'Aucun' }];
  return (
    <Field label="Matériel disponible" hint="Sans ce matériel, les stations sont remplacées par un exercice équivalent." gap="sm">
      <div role="group" aria-label="Matériel disponible" className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value.includes(o.value)}
            onClick={() => onChange(toggleEquipment(value, o.value))}
            className={cn(CHIP, value.includes(o.value) ? CHIP_ON : CHIP_IDLE)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

function PriorityChips({ value, onChange }: { value: GoalPriority; onChange: (value: GoalPriority) => void }) {
  return (
    <Field label="Priorité" gap="sm">
      <div className="flex gap-2">
        {PRIORITIES.map((p) => (
          <button
            key={p.value}
            type="button"
            title={p.hint}
            aria-pressed={value === p.value}
            onClick={() => onChange(p.value)}
            className={cn(CHIP, 'w-10', value === p.value ? CHIP_ON : CHIP_IDLE)}
          >
            {p.value}
          </button>
        ))}
      </div>
    </Field>
  );
}

/**
 * Adds a goal, or edits one (`goal`): a race's name, date, distance, target
 * time and priority, a Hyrox's or a hybrid block's own fields. The server
 * checks every rule again and its French error shows under the form.
 */
function GoalForm({ goal, onDone }: { goal?: Goal; onDone: () => void }) {
  const queryClient = useQueryClient();
  const today = toLocalISODate();
  const editing = goal != null;
  const [type, setType] = useState<GoalType>(goal?.goal_type ?? 'race');
  const [name, setName] = useState(goal?.name ?? '');
  const [raceDate, setRaceDate] = useState(goal && goal.goal_type !== 'hybrid' ? goal.race_date : '');
  const storedDistance = goal && type === 'race' ? formatKm(goal.distance_km) : '';
  const [distance, setDistance] = useState(storedDistance);
  const [target, setTarget] = useState(goal?.target_time_sec != null ? formatRaceTime(goal.target_time_sec) : '');
  const [priority, setPriority] = useState<GoalPriority>(goal?.priority ?? 'A');
  const [division, setDivision] = useState<GoalDetails['division']>(goal?.details?.division ?? 'open');
  const [format, setFormat] = useState<GoalDetails['format']>(goal?.details?.format ?? 'solo');
  // A stored mixed category the form no longer allows (Pro, Solo) is not
  // shown selected but disabled: it is cleared, and the hint says why.
  const [category, setCategory] = useState<GoalDetails['category']>(() => {
    const stored = goal?.details?.category ?? null;
    const mixedAllowed = goal?.details?.division !== 'pro' && goal?.details?.format === 'doubles';
    return stored === 'mixed' && !mixedAllowed ? null : stored;
  });
  const [equipment, setEquipment] = useState<Equipment>(goal?.details?.equipment ?? ['none']);
  const storedWeeks = goal?.details?.weeks;
  const [weeks, setWeeks] = useState<8 | 12>(storedWeeks ?? 12);
  const [postpone, setPostpone] = useState(0);
  const [invalid, setInvalid] = useState<string | null>(null);

  const started = goal?.goal_type === 'hybrid' && blockStarted(goal, today);
  // A block keeps its dates unless its length changes or, once started, its
  // end is postponed; resized before it starts, it keeps its first Monday.
  let blockEnd = hybridEnd(weeks, today);
  if (goal && started) blockEnd = addDays(goal.race_date, postpone * 7);
  else if (goal && weeks === storedWeeks) blockEnd = goal.race_date;
  else if (goal && storedWeeks) blockEnd = resizedBlockEnd(blockStart(goal.race_date, storedWeeks), weeks, today);
  // A block has no mixed category: its loads are an athlete's own (Open).
  const blockCategory = category === 'mixed' ? null : category;

  const done = () => {
    invalidateWithDashboard(queryClient, qk.goals, qk.formCurve());
    onDone();
  };
  const create = useMutation({ mutationFn: goalsApi.create, onSuccess: done });
  const update = useMutation({
    mutationFn: (fields: Parameters<typeof goalsApi.update>[1]) => goalsApi.update(goal?.id ?? 0, fields),
    onSuccess: done,
  });
  const saving = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  // Mixed races in doubles and in Open only (services/goals.py): a choice that
  // rules it out drops it rather than sending what the server refuses.
  const chooseFormat = (next: GoalDetails['format']) => {
    setFormat(next);
    if (next === 'solo' && category === 'mixed') setCategory(null);
  };
  const chooseDivision = (next: GoalDetails['division']) => {
    setDivision(next);
    if (next === 'pro' && category === 'mixed') setCategory(null);
  };

  const submit = () => {
    const targetSec = target.trim() ? parseRaceTime(target) : null;
    const label = name.trim();
    if (type === 'race') {
      // An untouched distance keeps its stored value, not its rounded text.
      const km = goal && distance === storedDistance ? goal.distance_km : parseKm(distance);
      if (!label || !raceDate) return setInvalid('Nom et date de course requis.');
      if (km == null) return setInvalid('Distance entre 1 et 250 km.');
      if (target.trim() && targetSec == null) return setInvalid('Temps visé au format h:mm:ss.');
      setInvalid(null);
      const fields = { name: label, race_date: raceDate, distance_km: km, target_time_sec: targetSec, priority };
      return editing ? update.mutate(fields) : create.mutate(fields);
    }
    if (type === 'hyrox') {
      if (!label || !raceDate) return setInvalid('Nom et date du Hyrox requis.');
      if (category == null) return setInvalid('Choisis la catégorie : Hommes, Femmes ou Mixte.');
      if (target.trim() && targetSec == null) return setInvalid('Temps visé au format h:mm:ss.');
      setInvalid(null);
      const details = { ...goal?.details, division, format, category, equipment };
      const fields = { name: label, race_date: raceDate, target_time_sec: targetSec, priority, details };
      return editing ? update.mutate(fields) : create.mutate({ ...fields, goal_type: 'hyrox' });
    }
    if (!label) return setInvalid('Nom du bloc requis.');
    setInvalid(null);
    const details = { ...goal?.details, weeks, equipment, category: blockCategory };
    if (!goal) return create.mutate({ name: label, race_date: blockEnd, goal_type: 'hybrid', details });
    // Only a moved end is sent: an equipment edit leaves the block's dates be.
    return update.mutate({ name: label, details, ...(blockEnd !== goal.race_date && { race_date: blockEnd }) });
  };

  const km = parseKm(distance);
  let fields: ReactNode;
  if (type === 'race') {
    fields = (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Nom de la course" gap="sm">
            <Input value={name} maxLength={120} placeholder="Semi de Paris" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Date" gap="sm">
            <Input type="date" min={today} value={raceDate} onChange={(e) => setRaceDate(e.target.value)} />
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
          <PriorityChips value={priority} onChange={setPriority} />
        </div>
      </>
    );
  } else if (type === 'hyrox') {
    fields = (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Nom du Hyrox" gap="sm">
            <Input value={name} maxLength={120} placeholder="Hyrox Paris" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Date" gap="sm">
            <Input type="date" aria-label="Date du Hyrox" min={today} value={raceDate} onChange={(e) => setRaceDate(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Division" gap="sm">
            <Chips label="Division" options={DIVISIONS} value={division} onChange={chooseDivision} />
          </Field>
          <Field label="Format" gap="sm">
            <Chips label="Format" options={FORMATS} value={format} onChange={chooseFormat} />
          </Field>
        </div>
        <Field
          label="Catégorie"
          hint={format === 'solo' ? 'Mixte se court en duo.' : division === 'pro' ? 'Mixte se court en Open.' : undefined}
          gap="sm"
        >
          <Chips
            label="Catégorie"
            options={CATEGORIES.map((c) => (c.value === 'mixed' ? { ...c, title: 'En duo et en Open uniquement' } : c))}
            value={category}
            onChange={setCategory}
            disabled={(c) => c === 'mixed' && (format !== 'doubles' || division === 'pro')}
          />
        </Field>
        <EquipmentChips value={equipment} onChange={setEquipment} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Temps visé (facultatif)" hint="Format h:mm:ss" gap="sm">
            <Input inputMode="numeric" placeholder="1:15:00" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <PriorityChips value={priority} onChange={setPriority} />
        </div>
      </>
    );
  } else {
    fields = (
      <>
        <Field label="Nom du bloc" gap="sm">
          <Input value={name} maxLength={120} placeholder="Bloc hybride d’hiver" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Durée"
          hint={started ? 'Le bloc a commencé : sa durée ne change plus.' : undefined}
          gap="sm"
        >
          <Chips
            label="Durée"
            options={BLOCK_WEEKS.map((w) => ({ value: w, label: `${w} semaines` }))}
            value={weeks}
            onChange={setWeeks}
            disabled={(w) => started && w !== storedWeeks}
          />
        </Field>
        {started && (
          <Field label="Reporter la fin" hint="Jusqu’à 2 semaines plus tard, par exemple après une maladie ou un voyage." gap="sm">
            <Chips
              label="Reporter la fin"
              options={POSTPONE_WEEKS.map((n) => ({
                value: n,
                label: n === 0 ? 'Sans report' : `+${n} semaine${n > 1 ? 's' : ''}`,
              }))}
              value={postpone}
              onChange={setPostpone}
            />
          </Field>
        )}
        <p className="ui-inset px-3 py-2 text-xs font-sans text-text-secondary" aria-live="polite">
          {started
            ? `Fin le dimanche ${longDate(blockEnd, true)}`
            : `Du lundi ${longDate(blockStart(blockEnd, weeks))} au dimanche ${longDate(blockEnd, true)}`}
        </p>
        <Field
          label="Catégorie"
          hint="Fixe les charges des stations (Open). Sans catégorie, tu choisis toi-même tes charges."
          gap="sm"
        >
          <Chips
            label="Catégorie"
            options={CATEGORIES.filter((c) => c.value !== 'mixed')}
            value={blockCategory}
            onChange={setCategory}
          />
        </Field>
        <EquipmentChips value={equipment} onChange={setEquipment} />
      </>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn('space-y-3', !editing && 'border-t border-text-muted/10 pt-3')}
    >
      {!editing && (
        <Field label="Type d’objectif" gap="sm">
          <Chips
            label="Type d’objectif"
            options={GOAL_TYPES}
            value={type}
            onChange={(next) => {
              setType(next);
              setInvalid(null);
              create.reset();
            }}
          />
        </Field>
      )}
      {fields}
      {(invalid || failure) && (
        <p role="alert" className="text-xs font-sans text-danger-red">
          {invalid ?? readableError(failure)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Annuler
        </Button>
        <Button type="submit" size="sm" loading={saving}>
          {editing ? 'Enregistrer' : SUBMIT_LABEL[type]}
        </Button>
      </div>
    </form>
  );
}

/** What the row says under the name: the date and distance, the division, or the block's dates. */
function goalLine(goal: Goal): string {
  const target = goal.target_time_sec != null ? ` · objectif ${formatRaceTime(goal.target_time_sec)}` : '';
  if (goal.goal_type === 'hybrid') {
    const weeks = goal.details?.weeks;
    return `Bloc hybride${weeks ? ` · ${weeks} semaines` : ''} · fin le ${longDate(goal.race_date, true)}`;
  }
  const date = longDate(goal.race_date, true);
  if (goal.goal_type === 'hyrox') {
    const category = goal.details?.category ? ` · ${CATEGORY_LABEL[goal.details.category]}` : '';
    return `${date} · ${hyroxLabel(goal.details)}${category}${target}`;
  }
  return `${date} · ${formatKm(goal.distance_km)} km${target}`;
}

function GoalRow({
  goal,
  onPlan,
  onEdit,
  onDelete,
}: {
  goal: Goal;
  onPlan: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const block = goal.goal_type === 'hybrid';
  return (
    <li className={cn('rounded border border-text-muted/20 p-3 space-y-2', goal.status !== 'active' && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-text-primary truncate">
            {!block && (
              <span className="font-sans text-neon-gold mr-2" title="Priorité">
                {goal.priority}
              </span>
            )}
            {goal.name}
          </p>
          <p className="text-xs font-sans text-text-muted">{goalLine(goal)}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-sans text-neon-cyan">{goal.days_left > 0 ? `J-${goal.days_left}` : 'Jour J'}</p>
          <p className="text-[11px] font-sans text-text-muted">
            {block && goal.status === 'done' ? 'terminé' : STATUS_LABEL[goal.status]}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="purple" size="sm" onClick={onPlan} disabled={goal.status !== 'active'}>
          <CalendarRange className="size-3.5" /> Générer le plan
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Modifier ${goal.name}`}>
          <Pencil className="size-3.5" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Supprimer ${goal.name}`}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

/** Goals: races, Hyrox races and hybrid blocks; they act at once, apart from the settings form's save button. */
export function RaceGoalsPanel() {
  const queryClient = useQueryClient();
  const goals = useQuery({ queryKey: qk.goalList, queryFn: () => goalsApi.list() });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<Goal | null>(null);
  const [planFor, setPlanFor] = useState<Goal | null>(null);
  // The changed sessions the last deleted goal left in the planning, until another goal is opened.
  const [kept, setKept] = useState(0);

  const remove = useMutation({
    mutationFn: (id: number) => goalsApi.remove(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: qk.goals });
      // The goal's future generated sessions go with it, apart from the changed ones.
      invalidateAfterSession(queryClient);
      setKept(result.kept);
      setToDelete(null);
    },
  });
  const closeDelete = () => {
    setToDelete(null);
    remove.reset();
  };

  return (
    <Panel
      level={3}
      variant="inset"
      title={
        <span className="flex items-center gap-2">
          <Flag className="size-4 text-neon-gold" /> Courses et blocs
        </span>
      }
    >
      <div className="space-y-3">
        {goals.isLoading && <p className="text-sm text-text-muted">Chargement des objectifs…</p>}
        {goals.isError && <p className="text-sm text-danger-red">Objectifs indisponibles.</p>}
        {kept > 0 && (
          <p role="status" className="text-xs text-text-muted">
            Objectif supprimé. {keptEditsText(kept)}
          </p>
        )}
        {goals.data?.length === 0 && !adding && (
          <p className="text-sm text-text-muted">
            Aucun objectif prévu. Ajoute une course, un Hyrox ou un bloc hybride pour construire ton plan.
          </p>
        )}
        {goals.data && goals.data.length > 0 && (
          <ul className="space-y-2">
            {goals.data.map((goal) =>
              editing === goal.id ? (
                <li key={goal.id} className="rounded border border-neon-cyan/30 p-3">
                  <GoalForm goal={goal} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <GoalRow
                  key={goal.id}
                  goal={goal}
                  onPlan={() => setPlanFor(goal)}
                  onEdit={() => {
                    setKept(0);
                    setEditing(goal.id);
                  }}
                  onDelete={() => setToDelete(goal)}
                />
              )
            )}
          </ul>
        )}
        {adding ? (
          <GoalForm onDone={() => setAdding(false)} />
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setKept(0);
              setAdding(true);
            }}
          >
            <Plus className="size-3.5" /> Ajouter un objectif
          </Button>
        )}
      </div>

      {/* The settings tab is a transformed, blurred panel: a fixed overlay must leave it. */}
      {createPortal(
        <Modal open={toDelete !== null} onClose={closeDelete} className="max-w-sm p-4 sm:p-6">
          <ModalHeader title="Supprimer l’objectif" onClose={closeDelete} className="mb-4" />
          <p className="text-sm text-text-secondary mb-2">Supprimer « {toDelete?.name} » ?</p>
          <p className="text-xs text-text-muted mb-6">
            Les séances à venir générées pour cet objectif sont supprimées aussi. Celles déjà modifiées, par toi ou par le
            coach, restent dans ton planning.
          </p>
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
