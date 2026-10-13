import { useId, useState } from 'react';
import { inputClasses } from '@/components/ui/Input';
import { digitsValue, formatDigits, maskDigits, valueDigits, type TimeMask } from '@/lib/timeMask';

const inputClass = inputClasses('cyan', 'text-sm');
const FORMAT: Record<TimeMask, { placeholder: string; pattern: string }> = {
  duration: { placeholder: 'mm:ss', pattern: '[0-9:]*' },
  pace: { placeholder: "m'ss", pattern: "[0-9']*" },
};

/**
 * Digits only, filled from the right like a timer; the separator appears by itself.
 * Seconds of 60 or more count as typed and read normalised on blur ("0:90" → "1:30").
 */
export function TimeInput({ mask, label, accessibleLabel, value, error, onChange }: { mask: TimeMask; label: string; accessibleLabel?: string; value: number | null; error: string; onChange: (value: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  // A step moved, or a value changed elsewhere, shows the stored value again.
  const digits = draft !== null && digitsValue(draft, mask) === value ? draft : valueDigits(value, mask);
  const invalid = value === null;
  const errorId = useId();
  return <div className="text-xs"><label>{label}
    {/* The pattern admits the separator: the field sits in forms the browser validates. */}
    <input className={inputClass} inputMode="numeric" pattern={FORMAT[mask].pattern} autoComplete="off" placeholder={FORMAT[mask].placeholder} aria-label={accessibleLabel} value={formatDigits(digits, mask)} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} onChange={e => {
      const next = maskDigits(e.target.value, mask);
      setDraft(next);
      onChange(digitsValue(next, mask));
    }} onBlur={() => setDraft(null)} /></label>
    {invalid && <span id={errorId} role="alert" className="mt-1 block text-danger-red">{error}</span>}
  </div>;
}
