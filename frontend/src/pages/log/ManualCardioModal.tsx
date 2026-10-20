import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import { Button, Field, Input, Modal, ModalHeader, Select, Textarea } from '@/components/ui';
import { garminApi } from '@/lib/api';
import { toLocalISODate } from '@/lib/dates';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';

const SPORTS = [
  { value: 'running', label: 'Course' },
  { value: 'cycling', label: 'Vélo' },
  { value: 'swimming', label: 'Natation' },
  { value: 'hiking', label: 'Randonnée' },
  { value: 'walking', label: 'Marche' },
  { value: 'other', label: 'Autre' },
];

const empty = () => ({
  date: toLocalISODate(),
  sport: 'running',
  name: '',
  duration_min: 45,
  distance_km: '' as number | '',
  avg_hr: '' as number | '',
  rpe: '' as number | '',
  notes: '',
});

/** Log a cardio session done without a watch (no FIT file to upload). */
export function ManualCardioModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Called with the new session's id, in place of onClose: a save closes the
   * screen where its feedback appears, a dismissal may leave the page.
   */
  onCreated: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(empty());
  const dateId = useId();

  const createMutation = useMutation({
    mutationFn: () =>
      garminApi.createActual({
        date: form.date,
        sport: form.sport,
        name: form.name || null,
        duration_min: Number(form.duration_min),
        distance_km: form.distance_km === '' ? null : Number(form.distance_km),
        avg_hr: form.avg_hr === '' ? null : Number(form.avg_hr),
        rpe: form.rpe === '' ? null : Number(form.rpe),
        notes: form.notes || null,
      }),
    onSuccess: (session) => {
      invalidateAfterSession(queryClient);
      setForm(empty());
      onCreated(session.id);
    },
  });

  // A save in flight keeps the screen: leaving the page would lose its outcome.
  const dismiss = () => { if (!createMutation.isPending) onClose(); };

  return (
    <Modal mobileSheet open={open} onClose={dismiss} className="max-w-md p-4 sm:p-6">
      <ModalHeader title="Séance sans montre" icon={<Plus className="w-5 h-5" />} onClose={dismiss} className="mb-4" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          createMutation.mutate();
        }}
        className="space-y-4"
      >
        {/* A phone column is too narrow for a full date: stacked, like the planning editor. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Date" htmlFor={dateId}>
            <Input
              id={dateId}
              type="date"
              className="session-date-input"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              required
            />
          </Field>
          <Field label="Sport">
            <Select value={form.sport} onChange={(e) => setForm((f) => ({ ...f, sport: e.target.value }))}>
              {SPORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Nom (optionnel)">
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Footing au parc"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Durée (min)">
            <Input
              type="number"
              min={1}
              max={1440}
              required
              value={form.duration_min}
              onChange={(e) => setForm((f) => ({ ...f, duration_min: Number(e.target.value) }))}
            />
          </Field>
          <Field label="Distance (km)">
            <Input
              type="number"
              step="0.1"
              min={0}
              value={form.distance_km}
              onChange={(e) =>
                setForm((f) => ({ ...f, distance_km: e.target.value === '' ? '' : Number(e.target.value) }))
              }
              placeholder="10"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="FC moyenne">
            <Input
              type="number"
              min={30}
              max={250}
              value={form.avg_hr}
              onChange={(e) => setForm((f) => ({ ...f, avg_hr: e.target.value === '' ? '' : Number(e.target.value) }))}
              placeholder="150"
            />
          </Field>
          <Field label="RPE (1-10)">
            <Input
              type="number"
              min={1}
              max={10}
              value={form.rpe}
              onChange={(e) => setForm((f) => ({ ...f, rpe: e.target.value === '' ? '' : Number(e.target.value) }))}
              placeholder="6"
            />
          </Field>
        </div>

        <Field label="Notes">
          <Textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={2}
            placeholder="Sensations, météo…"
          />
        </Field>

        {createMutation.isError && (
          <p className="text-xs font-sans text-danger-red">
            Enregistrement impossible : {readableError(createMutation.error)}
          </p>
        )}

        <Button type="submit" strong size="lg" fullWidth loading={createMutation.isPending}>
          {createMutation.isPending ? (
            'Enregistrement…'
          ) : (
            <>
              <Check className="w-4 h-4" />
              Enregistrer
            </>
          )}
        </Button>
      </form>
    </Modal>
  );
}
