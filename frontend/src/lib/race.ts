import { parseLocalDate, toLocalISODate } from '@/lib/dates';
import type { Goal, GoalDetails, RaceKey } from '@/types';

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

/** "17 janvier", or "17 janvier 2027" with the year. */
export function longDate(iso: string, withYear = false): string {
  return parseLocalDate(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** "Hyrox Pro · Duo": the division, and the format when it is not solo. */
export function hyroxLabel(details: Pick<GoalDetails, 'division' | 'format'> | null | undefined): string {
  const division = details?.division === 'pro' ? 'Pro' : 'Open';
  return `Hyrox ${division}${details?.format === 'doubles' ? ' · Duo' : ''}`;
}

type Described = Pick<Goal, 'distance_km' | 'race_date'> & Partial<Pick<Goal, 'goal_type' | 'details'>>;

/** What a goal is, after its name: "21,1 km", "Hyrox Open", "Bloc hybride · fin le 17 janvier". */
export function goalKind(goal: Described): string {
  if (goal.goal_type === 'hybrid') return `Bloc hybride · fin le ${longDate(goal.race_date)}`;
  if (goal.goal_type === 'hyrox') return hyroxLabel(goal.details);
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
