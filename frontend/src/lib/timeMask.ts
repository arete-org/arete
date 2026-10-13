import { formatElapsed } from './activity';
import { formatPace } from './utils';

/** A duration reads h:mm:ss (seconds); a pace m'ss per km (seconds per km). */
export type TimeMask = 'duration' | 'pace';

const MAX_DIGITS: Record<TimeMask, number> = { duration: 6, pace: 4 };
/** Plausible values, trail and ultra included: a step of at most 24:00:00, a pace from 1'30 to 30'00 per km. */
const LIMITS: Record<TimeMask, { min: number; max: number }> = { duration: { min: 1, max: 86_400 }, pace: { min: 90, max: 1_800 } };
/** A pasted value: digits only, or written in full with two-digit seconds (and minutes after hours). */
const PASTED: Record<TimeMask, RegExp> = { duration: /^(?:\d+|(?:\d{1,2}:\d{2}|\d{1,2}):\d{2})$/, pace: /^(?:\d+|\d{1,2}['’]\d{2})$/ };

const digitsOf = (text: string) => text.replace(/\D/g, '').replace(/^0+/, '');

/** Digits read from the right: the last two are seconds, then minutes, then hours (durations only). */
function split(digits: string, mask: TimeMask): { hours: string; minutes: string; seconds: string } {
  const padded = digits.padStart(3, '0');
  const [rest, seconds] = [padded.slice(0, -2), padded.slice(-2)];
  return mask === 'pace' || rest.length <= 2
    ? { hours: '', minutes: rest, seconds }
    : { hours: rest.slice(0, -2), minutes: rest.slice(-2), seconds };
}

/** Digits filled from the right like a timer: "2000" → "20:00", "13000" → "1:30:00", "330" → "3'30". */
export function formatDigits(digits: string, mask: TimeMask): string {
  if (!digits) return '';
  const { hours, minutes, seconds } = split(digits, mask);
  return mask === 'pace' ? `${minutes}'${seconds}` : `${hours ? `${hours}:` : ''}${minutes}:${seconds}`;
}

/** Seconds the digits stand for, each unit read as typed ("0:90" is 90 s); null when empty or zero. */
export function digitsValue(digits: string, mask: TimeMask): number | null {
  const { hours, minutes, seconds } = split(digits, mask);
  const total = Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total > 0 ? total : null;
}

/** The normalised digits of a stored value, however long: 90 s → "130" (1:30), 255 s/km → "415" (4'15). */
export function valueDigits(value: number | null, mask: TimeMask): string {
  return value === null ? '' : digitsOf(mask === 'pace' ? formatPace(value) : formatElapsed(value));
}

/**
 * The digits after the browser edited the shown text, the caret being kept at the end.
 * A digit is appended, or replaces the value when `replace` (focused, not yet typed);
 * a deletion removes the last digit (the browser's inputType tells it from a digit replacing a selection).
 * Null when the edit is ignored: other characters, digits past the limit.
 */
export function editDigits(digits: string, shown: string, raw: string, replace: boolean, mask: TimeMask, deleting = raw.length < shown.length): string | null {
  if (deleting) return replace || !raw ? '' : digits.slice(0, -1);
  const appended = raw.startsWith(shown);
  const typed = (appended ? raw.slice(shown.length) : raw).replace(/\D/g, '');
  if (!typed) return null;
  const next = (appended && !replace ? digits + typed : typed).replace(/^0+/, '');
  return next.length > MAX_DIGITS[mask] && next.length > digits.length ? null : next;
}

/** The digits of a pasted value, which replaces the field; null when it is not a plain value. */
export function pastedDigits(text: string, mask: TimeMask): string | null {
  const trimmed = text.trim();
  if (!PASTED[mask].test(trimmed)) return null;
  const digits = digitsOf(trimmed);
  return digits.length <= MAX_DIGITS[mask] ? digits : null;
}

/** Whether a value is plausible for its field; the editor saves nothing else. */
export const plausibleTime = (value: number, mask: TimeMask) => value >= LIMITS[mask].min && value <= LIMITS[mask].max;
