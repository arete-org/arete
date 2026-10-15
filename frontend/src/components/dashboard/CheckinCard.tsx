import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, X } from 'lucide-react';
import { Button, inputClasses } from '@/components/ui';
import {
  afterCheckin, checkinApi, checkinDismissed, dismissCheckin, MAX_CHECKIN_NOTE, type CheckinAnswer,
} from '@/lib/checkins';
import { readableError } from '@/lib/utils';

type Field = 'sleep' | 'legs' | 'mood';

/** Each answer's five words, 1 the worst: only both ends are written under the chips. */
const QUESTIONS: { field: Field; legend: string; optional?: boolean; words: readonly string[] }[] = [
  { field: 'sleep', legend: 'Sommeil ?', words: ['très mauvais', 'mauvais', 'moyen', 'bon', 'excellent'] },
  { field: 'legs', legend: 'Jambes ?', words: ['très lourdes', 'lourdes', 'normales', 'légères', 'très fraîches'] },
  {
    field: 'mood',
    legend: 'Motivation / stress',
    optional: true,
    words: ['stressé, sans envie', 'tendu', 'neutre', 'motivé', 'motivé et serein'],
  },
];

function Scale({
  name, legend, optional, words, value, disabled, onChange, onClear, firstRef,
}: {
  name: string;
  legend: string;
  optional?: boolean;
  words: readonly string[];
  value: number | undefined;
  disabled: boolean;
  onChange: (value: number) => void;
  /** An optional answer can be withdrawn: a native radio cannot be unchecked. */
  onClear?: () => void;
  firstRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={`${name}-label`}
      className="min-w-0 sm:grid sm:grid-cols-[9rem_minmax(0,20rem)] sm:items-start sm:gap-3"
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 sm:mb-0 sm:block sm:pt-3">
        <p id={`${name}-label`} className="text-sm font-sans text-text-primary">
          {legend}
          {optional && <> <span className="text-xs text-text-muted">(facultatif)</span></>}
        </p>
        {onClear && value !== undefined && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            aria-label={`Effacer la réponse ${legend}`}
            className="-my-3 inline-flex min-h-11 items-center text-xs font-sans text-neon-cyan hover:underline"
          >
            Effacer
          </button>
        )}
      </div>
      <div>
        <div className="grid grid-cols-5 gap-1.5">
          {words.map((word, index) => (
            <label key={word} className="relative">
              {/* A native radio over the whole chip: arrows move within the question, a tap selects. */}
              <input
                ref={index === 0 ? firstRef : undefined}
                type="radio"
                name={name}
                value={index + 1}
                checked={value === index + 1}
                disabled={disabled}
                onChange={() => onChange(index + 1)}
                aria-label={`${index + 1} sur 5 — ${word}`}
                className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded opacity-0 disabled:cursor-default"
              />
              <span
                aria-hidden
                className="flex min-h-11 items-center justify-center rounded border border-text-muted/25 bg-abyss text-sm font-sans tabular-nums text-text-secondary transition-colors motion-reduce:transition-none peer-hover:border-neon-cyan peer-checked:border-neon-cyan peer-checked:bg-neon-cyan/15 peer-checked:font-semibold peer-checked:text-neon-cyan peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-neon-cyan peer-disabled:opacity-60"
              >
                {index + 1}
              </span>
            </label>
          ))}
        </div>
        <div aria-hidden className="mt-0.5 flex justify-between gap-2 text-[11px] font-sans text-text-muted">
          <span>{words[0]}</span>
          <span className="text-right">{words[words.length - 1]}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The morning check-in: sleep, legs, then « Valider » — three taps. Shown
 * until the day is answered; « Plus tard » hides it for the day on this
 * device. `focus` (the push's `?checkin=1`) brings it back and into view,
 * once: `onFocused` lets the page drop the parameter.
 */
export function CheckinCard({
  day,
  focus = false,
  onFocused,
}: {
  day: string;
  focus?: boolean;
  /** Called once the card took the focus: the caller drops `?checkin=1`. */
  onFocused?: () => void;
}) {
  const client = useQueryClient();
  const id = useId();
  const first = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLInputElement>(null);
  const [hidden, setHidden] = useState(() => !focus && checkinDismissed(day));
  const [answer, setAnswer] = useState<Partial<Record<Field, number>>>({});
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: (body: CheckinAnswer) => checkinApi.save(day, body),
    onSuccess: (saved) => afterCheckin(client, saved),
  });

  useEffect(() => {
    if (!focus || hidden) return;
    first.current?.closest('section')?.scrollIntoView?.({ block: 'center' });
    first.current?.focus({ preventScroll: true });
    onFocused?.();
  }, [focus, hidden, onFocused]);

  // « + Ajouter un mot » leaves with its button: the focus goes to the field.
  useEffect(() => {
    if (noting) noteInput.current?.focus();
  }, [noting]);

  if (hidden) return null;
  const ready = answer.sleep !== undefined && answer.legs !== undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || save.isPending) return;
    save.mutate({ sleep: answer.sleep!, legs: answer.legs!, mood: answer.mood ?? null, note: note.trim() || null });
  };
  const later = () => {
    dismissCheckin(day);
    setHidden(true);
  };

  return (
    <section aria-labelledby={`${id}-title`} className="glass-panel p-3 sm:p-4 animate-fade-up">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ClipboardCheck aria-hidden className="w-4 h-4 text-neon-cyan" />
            <h2 id={`${id}-title`} className="text-sm font-sans text-text-muted uppercase tracking-wider">
              Check-in du matin
            </h2>
          </div>
          <p className="mt-1 text-xs font-sans text-text-muted">
            Dix secondes : une nuit difficile ou des jambes lourdes peuvent alléger la séance du jour.
          </p>
        </div>
        <button
          type="button"
          onClick={later}
          aria-label="Plus tard : masquer le check-in pour aujourd’hui"
          className="-mr-2 -mt-2 flex size-11 shrink-0 items-center justify-center rounded hover:bg-text-muted/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neon-cyan"
        >
          <X aria-hidden className="size-4 text-text-muted" />
        </button>
      </div>
      <form onSubmit={submit} className="space-y-3">
        {QUESTIONS.map((q) => (
          <Scale
            key={q.field}
            name={`${id}-${q.field}`}
            legend={q.legend}
            optional={q.optional}
            words={q.words}
            value={answer[q.field]}
            disabled={save.isPending}
            onChange={(value) => setAnswer((current) => ({ ...current, [q.field]: value }))}
            onClear={q.optional ? () => setAnswer(({ [q.field]: _, ...rest }) => rest) : undefined}
            firstRef={q.field === 'sleep' ? first : undefined}
          />
        ))}
        {noting && (
          <label className="block">
            <span className="mb-1 block text-xs font-sans text-text-muted">Un mot (facultatif)</span>
            <input
              ref={noteInput}
              type="text"
              value={note}
              maxLength={MAX_CHECKIN_NOTE}
              onChange={(event) => setNote(event.target.value)}
              disabled={save.isPending}
              className={inputClasses('cyan', 'text-base sm:text-sm')}
            />
          </label>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!noting && (
            <button
              type="button"
              onClick={() => setNoting(true)}
              className="mr-auto min-h-11 text-xs font-sans text-neon-cyan hover:underline"
            >
              + Ajouter un mot
            </button>
          )}
          <Button type="submit" variant="cyan" size="lg" strong disabled={!ready} loading={save.isPending}>
            Valider
          </Button>
        </div>
        {save.isError && (
          <p role="alert" className="text-xs font-sans text-danger-red">
            Check-in non enregistré : {readableError(save.error)}
          </p>
        )}
      </form>
    </section>
  );
}
