import type { Goal, RaceKey } from '@/types';

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

/** "J-65 · Semi de Paris (21,1 km)"; race day reads "Jour J"; a hybrid block has no distance. */
export function goalCountdown(goal: Pick<Goal, 'name' | 'days_left' | 'distance_km' | 'goal_type'>): string {
  const when = goal.days_left > 0 ? `J-${goal.days_left}` : 'Jour J';
  if (goal.goal_type === 'hybrid') return `${when} · ${goal.name}`;
  return `${when} · ${goal.name} (${formatKm(goal.distance_km)} km)`;
}

/** Race equivalents of GET /metrics/paces, in display order. */
export const RACE_LABEL: Record<RaceKey, string> = {
  '5k': '5 km',
  '10k': '10 km',
  half: 'Semi',
  marathon: 'Marathon',
};
