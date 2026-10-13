import { formatElapsed } from './activity';
import { formatPace } from './utils';

/** A duration reads h:mm:ss (seconds); a pace m'ss per km (seconds per km). */
export type TimeMask = 'duration' | 'pace';

const MAX_DIGITS: Record<TimeMask, number> = { duration: 6, pace: 4 };

/** The digits of a typed or pasted text: separators and leading zeros dropped, at most the mask's length. */
export function maskDigits(text: string, mask: TimeMask): string {
  return text.replace(/\D/g, '').replace(/^0+/, '').slice(0, MAX_DIGITS[mask]);
}

/** Digits filled from the right like a timer: "2000" → "20:00", "13000" → "1:30:00", "330" → "3'30". */
export function formatDigits(digits: string, mask: TimeMask): string {
  if (!digits) return '';
  const padded = digits.padStart(3, '0');
  const [rest, seconds] = [padded.slice(0, -2), padded.slice(-2)];
  if (mask === 'pace') return `${rest}'${seconds}`;
  return rest.length > 2 ? `${rest.slice(0, -2)}:${rest.slice(-2)}:${seconds}` : `${rest}:${seconds}`;
}

/** Seconds the digits stand for, each unit read as typed ("0:90" is 90 s); null when empty or zero. */
export function digitsValue(digits: string, mask: TimeMask): number | null {
  const padded = digits.padStart(3, '0');
  const [rest, seconds] = [padded.slice(0, -2), Number(padded.slice(-2))];
  const total = mask === 'pace'
    ? Number(rest) * 60 + seconds
    : Number(rest.slice(0, -2) || 0) * 3600 + Number(rest.slice(-2)) * 60 + seconds;
  return total > 0 ? total : null;
}

/** The normalised digits of a stored value: 90 s → "130" (1:30), 255 s/km → "415" (4'15). */
export function valueDigits(value: number | null, mask: TimeMask): string {
  if (value === null) return '';
  return (mask === 'pace' ? formatPace(value) : formatElapsed(value)).replace(/\D/g, '').replace(/^0+/, '');
}
