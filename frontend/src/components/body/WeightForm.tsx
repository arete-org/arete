import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input } from '@/components/ui';
import {
  afterBodyWrite, bodyApi, MAX_PAST_DAYS, MAX_WEIGHT_KG, MIN_WEIGHT_KG, parseWeight, shiftDay, useAthleteToday,
  type WeightEntry,
} from '@/lib/bodyLog';
import { readableError } from '@/lib/utils';

/** The day's weight: entering it again for the same day corrects it. */
export function WeightForm({ onSaved, onCancel }: { onSaved?: (saved: WeightEntry) => void; onCancel?: () => void }) {
  const id = useId();
  const client = useQueryClient();
  const today = useAthleteToday();
  const [date, setDate] = useState(today);
  const [text, setText] = useState('');
  const weight = parseWeight(text);
  const save = useMutation({
    mutationFn: (kg: number) => bodyApi.saveWeight(date, kg),
    onSuccess: async (saved) => {
      await afterBodyWrite(client);
      onSaved?.(saved);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (weight === null || save.isPending) return;
    save.mutate(weight);
  };
  const invalid = text.trim() !== '' && weight === null;

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Noter mon poids">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Poids (kg)" htmlFor={`${id}-kg`} gap="sm">
          <Input
            id={`${id}-kg`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="71,4"
            value={text}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-error` : undefined}
            disabled={save.isPending}
            onChange={(event) => setText(event.target.value)}
            className="min-h-11 text-base sm:text-sm tabular-nums"
          />
        </Field>
        <Field label="Jour" htmlFor={`${id}-date`} gap="sm">
          <Input
            id={`${id}-date`}
            type="date"
            value={date}
            min={shiftDay(today, -MAX_PAST_DAYS)}
            max={today}
            required
            disabled={save.isPending}
            onChange={(event) => setDate(event.target.value)}
            className="min-h-11 text-base sm:text-sm"
          />
        </Field>
      </div>
      {invalid && (
        <p id={`${id}-error`} className="text-xs font-sans text-danger-red">
          Un poids va de {MIN_WEIGHT_KG} à {MAX_WEIGHT_KG} kg.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {onCancel && (
          <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={save.isPending}>
            Annuler
          </Button>
        )}
        <Button type="submit" variant="cyan" size="lg" strong disabled={weight === null || date === ''} loading={save.isPending}>
          Enregistrer
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="text-xs font-sans text-danger-red">
          Poids non enregistré : {readableError(save.error)}
        </p>
      )}
    </form>
  );
}
