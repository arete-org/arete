import { useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { digitsValue, editDigits, formatDigits, pastedDigits, plausibleTime, valueDigits, type TimeMask } from '@/lib/timeMask';

const COPY: Record<TimeMask, { placeholder: string; pattern: string; hint: string; empty: string; implausible: string; pasted: string }> = {
  duration: { placeholder: '0:00', pattern: '[0-9:]*', hint: 'Tape 2000 pour 20:00', empty: 'Indique la durée.', implausible: 'Durée au-delà de 10:00:00 : vérifie la saisie.', pasted: 'Collage refusé : chiffres ou durée comme 1:30:00.' },
  pace: { placeholder: "0'00", pattern: "[0-9']*", hint: "Tape 330 pour 3'30", empty: 'Indique l’allure.', implausible: "Allure attendue entre 1'30 et 20'00 par km.", pasted: "Collage refusé : chiffres ou allure comme 3'30." },
};

/**
 * Digits only, filled from the right like a timer; the separator appears by itself.
 * Focusing selects the value so the first digit restarts it; seconds of 60 or more
 * count as typed and read normalised on blur ("0:90" → "1:30").
 */
export function TimeInput({ mask, label, accessibleLabel, value, onChange }: { mask: TimeMask; label: string; accessibleLabel?: string; value: number | null; onChange: (value: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const replace = useRef(false);
  // A step moved, or a value changed elsewhere, shows the stored value again.
  const digits = draft !== null && digitsValue(draft, mask) === value ? draft : valueDigits(value, mask);
  const shown = formatDigits(digits, mask);
  const copy = COPY[mask];
  const error = rejected ? copy.pasted : value === null ? copy.empty : plausibleTime(value, mask) ? null : copy.implausible;
  const hintId = useId();
  const errorId = useId();
  const commit = (next: string) => {
    replace.current = false;
    setRejected(false);
    setDraft(next);
    onChange(digitsValue(next, mask));
  };
  return <div className="text-xs"><label>{label}
    {/* The pattern admits the separator: the field sits in forms the browser validates. */}
    <Input accent="cyan" className="text-sm" inputMode="numeric" pattern={copy.pattern} autoComplete="off" placeholder={copy.placeholder} aria-label={accessibleLabel} value={shown} aria-invalid={error !== null} aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      onFocus={e => { replace.current = true; e.currentTarget.select(); }}
      // The click that focused the field must not collapse the selection the next digit replaces.
      onMouseUp={e => { if (replace.current) e.preventDefault(); }}
      onSelect={e => {
        // Timer semantics: the caret stays at the end, unless the whole value is selected to be replaced.
        const input = e.currentTarget;
        const end = input.value.length;
        if (input.selectionStart === 0 && input.selectionEnd === end) return;
        replace.current = false;
        if (input.selectionStart !== end) input.setSelectionRange(end, end);
      }}
      onPaste={e => {
        e.preventDefault();
        const next = pastedDigits(e.clipboardData.getData('text'), mask);
        if (next === null) setRejected(true);
        else commit(next);
      }}
      onChange={e => {
        const { inputType } = e.nativeEvent as InputEvent;
        const next = editDigits(digits, shown, e.target.value, replace.current, mask, inputType ? inputType.startsWith('delete') : undefined);
        if (next !== null) commit(next);
      }}
      onBlur={() => { replace.current = false; setDraft(null); }} /></label>
    <span id={hintId} className="mt-1 block text-text-muted">{copy.hint}</span>
    {error && <span id={errorId} role="alert" className="mt-1 block text-danger-red">{error}</span>}
  </div>;
}
