import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Select } from '@/components/ui';
import {
  afterBodyWrite, bodyApi, INTENSITY_ENDS, MAX_PAIN_NOTE, MAX_PAST_DAYS, PAIN_AREAS, SIDES,
  shiftDay, useAthleteToday, type PainAreaId, type PainEntry, type PainInput, type Side,
} from '@/lib/bodyLog';
import { readableError } from '@/lib/utils';

const chip =
  'flex min-h-11 items-center justify-center rounded border border-text-muted/25 bg-abyss px-2 text-sm font-sans tabular-nums text-text-secondary transition-colors motion-reduce:transition-none peer-hover:border-neon-cyan peer-checked:border-neon-cyan peer-checked:bg-neon-cyan/15 peer-checked:font-semibold peer-checked:text-neon-cyan peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-neon-cyan peer-disabled:opacity-60';

/** A native radio over a whole chip: arrows move within the group, a tap selects. */
function Chip({ name, label, checked, disabled, onChange, children }: {
  name: string; label: string; checked: boolean; disabled: boolean; onChange: () => void; children: string;
}) {
  return (
    <label className="relative">
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
        className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded opacity-0 disabled:cursor-default"
      />
      <span aria-hidden className={chip}>{children}</span>
    </label>
  );
}

/**
 * Record a pain, or correct one (`entry`): a day, an area, a side, 0 to 10 and
 * a note. Three taps from the dashboard: the area, the intensity, « Enregistrer ».
 */
export function PainForm({
  entry,
  defaultDate,
  onSaved,
  onCancel,
}: {
  entry?: PainEntry;
  defaultDate?: string;
  onSaved?: (saved: PainEntry) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const today = useAthleteToday();
  const earliest = shiftDay(today, -MAX_PAST_DAYS);
  // A session older than the log accepts dates its pain today.
  const [date, setDate] = useState(
    entry?.date ?? (defaultDate && defaultDate >= earliest && defaultDate <= today ? defaultDate : today),
  );
  const [area, setArea] = useState<PainAreaId | ''>(entry?.area ?? '');
  const [side, setSide] = useState<Side | null>(entry?.side ?? null);
  const [intensity, setIntensity] = useState<number | null>(entry?.intensity ?? null);
  const [note, setNote] = useState(entry?.note ?? '');
  const save = useMutation({
    mutationFn: (input: PainInput) => (entry ? bodyApi.updatePain(entry.id, input) : bodyApi.addPain(input)),
    onSuccess: async (saved) => {
      await afterBodyWrite(client);
      onSaved?.(saved);
    },
  });
  const ready = area !== '' && intensity !== null && date !== '';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || save.isPending) return;
    save.mutate({ date, area, side, intensity, note: note.trim() || null });
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label={entry ? 'Corriger la douleur' : 'Signaler une douleur'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Zone" htmlFor={`${id}-area`} gap="sm">
          <Select
            id={`${id}-area`}
            value={area}
            required
            disabled={save.isPending}
            onChange={(event) => setArea(event.target.value as PainAreaId)}
            className="min-h-11 text-base sm:text-sm"
          >
            <option value="" disabled>Choisir une zone</option>
            {PAIN_AREAS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </Select>
        </Field>
        <Field label="Jour" htmlFor={`${id}-date`} gap="sm">
          <Input
            id={`${id}-date`}
            type="date"
            value={date}
            min={earliest}
            max={today}
            required
            disabled={save.isPending}
            onChange={(event) => setDate(event.target.value)}
            className="min-h-11 text-base sm:text-sm"
          />
        </Field>
      </div>

      <div>
        <p id={`${id}-side`} className="mb-1 text-xs font-sans text-text-muted">Côté <span>(facultatif)</span></p>
        <div role="radiogroup" aria-labelledby={`${id}-side`} className="grid grid-cols-4 gap-1.5">
          <Chip name={`${id}-side`} label="Sans côté" checked={side === null} disabled={save.isPending} onChange={() => setSide(null)}>
            Aucun
          </Chip>
          {SIDES.map((s) => (
            <Chip key={s.id} name={`${id}-side`} label={s.label} checked={side === s.id} disabled={save.isPending} onChange={() => setSide(s.id)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <p id={`${id}-intensity`} className="mb-1 text-xs font-sans text-text-muted">Intensité, de 0 à 10</p>
        <div role="radiogroup" aria-labelledby={`${id}-intensity`} className="grid grid-cols-6 gap-1.5 sm:grid-cols-11">
          {Array.from({ length: 11 }, (_, value) => (
            <Chip
              key={value}
              name={`${id}-intensity`}
              label={`${value} sur 10${value === 0 ? ` — ${INTENSITY_ENDS[0]}` : value === 10 ? ` — ${INTENSITY_ENDS[1]}` : ''}`}
              checked={intensity === value}
              disabled={save.isPending}
              onChange={() => setIntensity(value)}
            >
              {String(value)}
            </Chip>
          ))}
        </div>
        <div aria-hidden className="mt-0.5 flex justify-between text-[11px] font-sans text-text-muted">
          <span>0 {INTENSITY_ENDS[0]}</span>
          <span>10 {INTENSITY_ENDS[1]}</span>
        </div>
      </div>

      <Field label="Note (facultatif)" htmlFor={`${id}-note`} gap="sm" hint="Par exemple : en descente, après 20 minutes, au réveil.">
        <Input
          id={`${id}-note`}
          type="text"
          value={note}
          maxLength={MAX_PAIN_NOTE}
          disabled={save.isPending}
          onChange={(event) => setNote(event.target.value)}
          className="min-h-11 text-base sm:text-sm"
        />
      </Field>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {onCancel && (
          <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={save.isPending}>
            Annuler
          </Button>
        )}
        <Button type="submit" variant="cyan" size="lg" strong disabled={!ready} loading={save.isPending}>
          Enregistrer
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="text-xs font-sans text-danger-red">
          Douleur non enregistrée : {readableError(save.error)}
        </p>
      )}
    </form>
  );
}
