import { parseLocalDate, toLocalISODate } from '@/lib/dates';
import type { Goal, GoalDetails, RaceKey, TriathlonDetails, TriDistance } from '@/types';

/** "21,1" from 21.1, "42,195" from 42.195: French decimals, no trailing zeros. */
export function formatKm(km: number): string {
  return km.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
}

/** "1:32:05" from 5525 seconds, "45:12" under an hour. */
export function formatRaceTime(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** Seconds from "h:mm:ss" or "mm:ss"; null when the text is not a duration. */
export function parseRaceTime(text: string): number | null {
  const match = text.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [h, m, s] = [Number(match[1] ?? 0), Number(match[2]), Number(match[3])];
  if (s > 59 || (match[1] != null && m > 59)) return null;
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : null;
}

/** 'YYYY-MM-DD' `days` after `iso`, in local dates. */
export function addDays(iso: string, days: number): string {
  const day = parseLocalDate(iso);
  day.setDate(day.getDate() + days);
  return toLocalISODate(day);
}

/**
 * The Sunday a hybrid block of `weeks` ends when it starts next Monday: the
 * earliest end services/goals.py hybrid_end_window accepts (on a Monday, next
 * Monday is a week later).
 */
export function hybridEnd(weeks: number, today: string = toLocalISODate()): string {
  const weekday = (parseLocalDate(today).getDay() + 6) % 7; // Monday 0
  return addDays(today, 7 - weekday + weeks * 7 - 1);
}

/** The Monday a block ending on Sunday `end` starts. */
export function blockStart(end: string, weeks: number): string {
  return addDays(end, 1 - weeks * 7);
}

/** Weeks a block may wait before it starts (services/goals.py HYBRID_LEAD_WEEKS). */
const HYBRID_LEAD_WEEKS = 2;

/**
 * The end of a block not started yet once resized to `weeks`: it keeps its
 * Monday `start`, within the window the server accepts for that length.
 */
export function resizedBlockEnd(start: string, weeks: number, today: string = toLocalISODate()): string {
  const earliest = hybridEnd(weeks, today);
  const latest = addDays(earliest, HYBRID_LEAD_WEEKS * 7);
  const end = addDays(start, weeks * 7 - 1);
  if (end < earliest) return earliest;
  return end > latest ? latest : end;
}

/** "17 janvier", or "17 janvier 2027" with the year. */
export function longDate(iso: string, withYear = false): string {
  return parseLocalDate(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** A Hyrox goal's or hybrid block's details; null for any other goal. */
export function hyroxDetails(goal: Partial<Pick<Goal, 'goal_type' | 'details'>> | null | undefined): GoalDetails | null {
  if (!goal?.details || (goal.goal_type !== 'hyrox' && goal.goal_type !== 'hybrid')) return null;
  return goal.details as GoalDetails;
}

/** A triathlon goal's details; null for any other goal. */
export function triDetails(goal: Partial<Pick<Goal, 'goal_type' | 'details'>> | null | undefined): TriathlonDetails | null {
  if (!goal?.details || goal.goal_type !== 'triathlon') return null;
  return goal.details as TriathlonDetails;
}

/**
 * The four triathlon formats (features/tri_plan.py): their name, legs and
 * the weekly hours a plan needs at least. « Distance Ironman » names a
 * distance, not the brand's race.
 */
export const TRI_FORMATS: { value: TriDistance; label: string; legs: string; minHours: number }[] = [
  { value: 'sprint', label: 'S', legs: '750 m · 20 km · 5 km', minHours: 4 },
  { value: 'olympic', label: 'M', legs: '1,5 km · 40 km · 10 km', minHours: 4 },
  { value: 'half', label: '70.3', legs: '1,9 km · 90 km · 21,1 km', minHours: 6 },
  { value: 'full', label: 'Distance Ironman', legs: '3,8 km · 180 km · 42,2 km', minHours: 8 },
];

/** "Triathlon M", "Triathlon distance Ironman". */
export function triLabel(details: Pick<TriathlonDetails, 'distance'> | null | undefined): string {
  const format = TRI_FORMATS.find((f) => f.value === details?.distance);
  if (!format) return 'Triathlon';
  return `Triathlon ${format.value === 'full' ? 'distance Ironman' : format.label}`;
}

/** "Hyrox Pro · Duo": the division, and the format when it is not solo. */
export function hyroxLabel(details: Pick<GoalDetails, 'division' | 'format'> | null | undefined): string {
  const division = details?.division === 'pro' ? 'Pro' : 'Open';
  return `Hyrox ${division}${details?.format === 'doubles' ? ' · Duo' : ''}`;
}

type Described = Pick<Goal, 'distance_km' | 'race_date'> & Partial<Pick<Goal, 'goal_type' | 'details'>>;

/** What a goal is, after its name: "21,1 km", "Hyrox Open", "Triathlon M", "Bloc hybride · fin le 17 janvier". */
export function goalKind(goal: Described): string {
  if (goal.goal_type === 'hybrid') return `Bloc hybride · fin le ${longDate(goal.race_date)}`;
  if (goal.goal_type === 'hyrox') return hyroxLabel(hyroxDetails(goal));
  if (goal.goal_type === 'triathlon') return triLabel(triDetails(goal));
  return `${formatKm(goal.distance_km)} km`;
}

/** "J-65 · Semi de Paris (21,1 km)"; race day reads "Jour J"; a hybrid block names its end, no distance. */
export function goalCountdown(goal: Pick<Goal, 'name' | 'days_left'> & Described): string {
  const when = goal.days_left > 0 ? `J-${goal.days_left}` : 'Jour J';
  return `${when} · ${goal.name} (${goalKind(goal)})`;
}

/** Race equivalents of GET /metrics/paces, in display order. */
export const RACE_LABEL: Record<RaceKey, string> = {
  '5k': '5 km',
  '10k': '10 km',
  half: 'Semi',
  marathon: 'Marathon',
};
