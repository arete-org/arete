import { useQuery, type QueryClient } from '@tanstack/react-query';
import { fetchAPI, settingsApi } from './api';
import { parseLocalDate, toLocalISODate } from './dates';
import { formatDecimal } from './fr';
import { qk } from './queryKeys';

/** Pain and body weight (`/body`, services/body_log.py): health data, behind consent. */

/** The server's fixed list (body_log.PAIN_AREAS), in the form's order. */
export const PAIN_AREAS = [
  { id: 'foot', label: 'Pied' },
  { id: 'ankle', label: 'Cheville' },
  { id: 'achilles', label: 'Tendon d’Achille' },
  { id: 'calf', label: 'Mollet' },
  { id: 'shin', label: 'Tibia' },
  { id: 'knee', label: 'Genou' },
  { id: 'quadriceps', label: 'Quadriceps' },
  { id: 'hamstring', label: 'Ischio-jambiers' },
  { id: 'hip', label: 'Hanche' },
  { id: 'groin', label: 'Aine' },
  { id: 'glute', label: 'Fessier' },
  { id: 'lower_back', label: 'Bas du dos' },
  { id: 'upper_back', label: 'Haut du dos' },
  { id: 'neck', label: 'Cou' },
  { id: 'shoulder', label: 'Épaule' },
  { id: 'elbow', label: 'Coude' },
  { id: 'wrist_hand', label: 'Poignet ou main' },
  { id: 'other', label: 'Autre' },
] as const;
export type PainAreaId = (typeof PAIN_AREAS)[number]['id'];

export const SIDES = [
  { id: 'left', label: 'Gauche' },
  { id: 'right', label: 'Droite' },
  { id: 'both', label: 'Les deux' },
] as const;
export type Side = (typeof SIDES)[number]['id'];

export const MAX_PAIN_NOTE = 280;
/** How far back an entry may be dated (body_log.MAX_PAST_DAYS). */
export const MAX_PAST_DAYS = 90;
export const MIN_WEIGHT_KG = 25;
export const MAX_WEIGHT_KG = 250;

/** The words under the 0-10 scale's ends. */
export const INTENSITY_ENDS = ['aucune', 'maximale'] as const;

export interface PainEntry {
  id: number;
  date: string;
  area: PainAreaId;
  side: Side | null;
  intensity: number;
  note: string | null;
  /** « genou, côté gauche », written by the server. */
  label: string;
  created_at: string;
  updated_at: string;
}
export interface PainInput {
  date: string;
  area: PainAreaId;
  side: Side | null;
  intensity: number;
  note: string | null;
}

export interface WeightEntry {
  date: string;
  weight_kg: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface WeightSummary {
  latest: WeightEntry | null;
  average_7d: number | null;
  /** The latest weight minus the earliest of the 28 days before it. */
  change_kg: number | null;
  change_since: string | null;
}

export interface AreaTrend {
  area: PainAreaId;
  side: Side | null;
  label: string;
  last_date: string;
  last_intensity: number;
  max_intensity: number;
  entries: number;
}

export interface BodyTrend {
  start: string;
  end: string;
  /** Newest first. */
  pain: PainEntry[];
  /** Oldest first. */
  weights: WeightEntry[];
  weight: WeightSummary;
  areas: AreaTrend[];
}

export interface ReportWeek {
  week_start: string;
  week_end: string;
  sessions: number;
  duration_min: number;
  distance_km: number;
  tss: number;
  acwr: number | null;
}
export interface ReportSession {
  date: string;
  kind: 'cardio' | 'strength';
  sport: string;
  duration_min: number;
  distance_km: number | null;
  avg_hr: number | null;
  rpe: number | null;
  tss: number;
}
export interface BodyReport {
  start: string;
  end: string;
  weeks: ReportWeek[];
  sessions: ReportSession[];
  /** Oldest first. */
  pain: PainEntry[];
  pain_areas: AreaTrend[];
  weights: WeightEntry[];
  weight: WeightSummary;
  readiness: {
    date: string;
    garmin_readiness: number | null;
    readiness: number | null;
    sleep_score: number | null;
    resting_hr: number | null;
    hrv: number | null;
  }[];
  checkins: { date: string; sleep: number | null; legs: number | null; mood: number | null }[];
  totals: { sessions: number; duration_min: number; pain_entries: number; max_pain: number | null };
}

export const bodyKeys = {
  all: ['body'] as const,
  trend: (days: number) => ['body', 'trend', days] as const,
  report: ['body', 'report'] as const,
};

export const bodyApi = {
  trend: (days = 56) => fetchAPI<BodyTrend>(`/body?days=${days}`),
  report: () => fetchAPI<BodyReport>('/body/report'),
  addPain: (input: PainInput) => fetchAPI<PainEntry>('/body/pain', { method: 'POST', body: JSON.stringify(input) }),
  updatePain: (id: number, input: PainInput) =>
    fetchAPI<PainEntry>(`/body/pain/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deletePain: (id: number) => fetchAPI<void>(`/body/pain/${id}`, { method: 'DELETE' }),
  saveWeight: (day: string, weightKg: number) =>
    fetchAPI<WeightEntry>(`/body/weight/${day}`, { method: 'PUT', body: JSON.stringify({ weight_kg: weightKg }) }),
  deleteWeight: (day: string) => fetchAPI<void>(`/body/weight/${day}`, { method: 'DELETE' }),
};

/** Any write refreshes the trend page and the report. */
export const afterBodyWrite = (client: QueryClient) => client.invalidateQueries({ queryKey: bodyKeys.all });

/** The calendar day in `zone` (the athlete's Settings timezone), as the server dates entries. */
export function todayIn(zone: string | null | undefined, at = new Date()): string {
  if (!zone) return toLocalISODate(at);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return toLocalISODate(at); // an unknown zone: the server reads it as Paris, close enough for a default
  }
}

/** `iso` moved by `days` calendar days. */
export function shiftDay(iso: string, days: number): string {
  const day = parseLocalDate(iso);
  day.setDate(day.getDate() + days);
  return toLocalISODate(day);
}

/**
 * Today on the athlete's clock: a browser in another timezone must not date
 * an entry on a day the server has not reached. Settings are already cached
 * by the app's provider, so this reads no more.
 */
export function useAthleteToday(): string {
  const { data } = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });
  return todayIn(data?.timezone);
}

/** « 71,4 kg » / « −0,8 kg ». */
export function formatKg(value: number, signed = false): string {
  return `${formatDecimal(value, 1, signed).replace('-', '−')} kg`;
}

/** « 22 oct. » or, with `weekday`, « mer. 22 oct. ». */
export function shortDate(iso: string, weekday = false): string {
  return parseLocalDate(iso).toLocaleDateString('fr-FR', {
    ...(weekday ? { weekday: 'short' } : {}),
    day: 'numeric',
    month: 'short',
  });
}

/** The day's « 71,4 » typed with a comma or a dot, or null when it is not a weight. */
export function parseWeight(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  if (!text.trim() || !Number.isFinite(value)) return null;
  return value >= MIN_WEIGHT_KG && value <= MAX_WEIGHT_KG ? Math.round(value * 10) / 10 : null;
}

/** The tone of a 0-10 pain: the number is always written beside it. */
export function painTone(intensity: number): 'calm' | 'warning' | 'danger' {
  return intensity >= 7 ? 'danger' : intensity >= 4 ? 'warning' : 'calm';
}

/** The weight's sentence: latest, then its change when there is one. */
export function weightSentence(summary: WeightSummary): string {
  if (!summary.latest) return 'Aucun poids noté sur la période.';
  const latest = `${formatKg(summary.latest.weight_kg)} le ${shortDate(summary.latest.date)}`;
  if (summary.change_kg === null || !summary.change_since) return latest;
  const change =
    summary.change_kg === 0 ? 'stable' : `${formatKg(summary.change_kg, true)}`;
  return `${latest} (${change} depuis le ${shortDate(summary.change_since)})`;
}
