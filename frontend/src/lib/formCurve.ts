import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAPI } from './api';
import { formatDecimal } from './fr';
import { qk } from './queryKeys';

/** One day of the curve: forme de fond (CTL), fatigue (ATL) and forme (TSB). */
export interface CurvePoint {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
  /** The day's load comes from the plan: the projection, after today. */
  planned: boolean;
}

/** `GET /dashboard/form-curve`: twelve weeks, then the projection to the next race. */
export interface FormCurve {
  today: string;
  goal_id: number | null;
  series: CurvePoint[];
  race_day: { ctl: number | null; tsb: number | null } | null;
  planned_sessions: number;
  /** The last planned session's day: the projection assumes rest after it. */
  last_planned: string | null;
  key_session: {
    id: number;
    date: string;
    session_type: string;
    description: string | null;
    target_duration_min: number | null;
  } | null;
}

export const formCurveApi = {
  get: async (): Promise<FormCurve> => {
    const data = await fetchAPI<FormCurve>('/dashboard/form-curve');
    // A curve without its series cannot be drawn: treat it as an empty one.
    return Array.isArray(data?.series) ? data : { ...data, series: [] };
  },
};

/**
 * A callback ref and whether its element has been on screen. A callback ref
 * observes whenever the element attaches, even after the first render;
 * without IntersectionObserver it counts as seen at once.
 */
export function useInView(): [(node: Element | null) => void, boolean] {
  const [node, setNode] = useState<Element | null>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  const ref = useCallback((element: Element | null) => setNode(element), []);
  useEffect(() => {
    if (seen || !node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, seen]);
  return [ref, seen];
}

/**
 * The curve's own request, never part of the dashboard's first burst: it
 * starts once the dashboard has answered (`enabled`) and a panel reading it
 * is on screen. The goal card and the curve share it.
 */
export function useFormCurve(day: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: qk.formCurve(day),
    queryFn: () => formCurveApi.get(),
    enabled: enabled && day !== undefined,
    staleTime: 30 * 60_000,
  });
}

/**
 * Half the width of the race-day band: ±3 up to 13 days before the race,
 * one more per further 14 days (±4 from 14 days, ±5 from 28…), at most ±8. The projection is a model over a plan
 * that may still change: the further the race, the wider it reads.
 */
export function formBandWidth(daysLeft: number): number {
  return Math.min(8, 3 + Math.floor(Math.max(0, daysLeft) / 14));
}

/** "entre +3 et +13": the projected form on race day as a band, never a false decimal. */
export function formBand(tsb: number, daysLeft: number): string {
  const centre = Math.round(tsb);
  const width = formBandWidth(daysLeft);
  return `entre ${formatDecimal(centre - width, 0, true)} et ${formatDecimal(centre + width, 0, true)}`;
}

/** The plan reaches race week: before that, the projection is mostly assumed rest. */
export function planReachesRaceWeek(curve: FormCurve, raceDate: string): boolean {
  if (!curve.last_planned) return false;
  const week = new Date(Date.parse(`${raceDate}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  return curve.last_planned >= week;
}

export const NO_LOAD = 'Pas encore de charge enregistrée : la courbe apparaîtra avec tes premières séances.';

const whole = (value: number) => formatDecimal(Math.round(value), 0);
const signed = (value: number) => formatDecimal(Math.round(value), 0, true);

/**
 * The curve in words, for screen readers and a phone at a glance: where the
 * forme de fond went over the weeks shown, today's fatigue and forme, and
 * race morning when a race is projected.
 */
export function curveSummary(curve: FormCurve): string {
  // Up to today the series is the logged load (the dashboard's form), after it the projection.
  const history = curve.series.filter((p) => p.date <= curve.today && !p.planned);
  const first = history[0];
  const now = history[history.length - 1];
  if (!first || !now) return NO_LOAD;
  const weeks = Math.max(1, Math.round((parseDay(now.date) - parseDay(first.date)) / (7 * 86_400_000)));
  const parts = [
    `Sur ${weeks} semaine${weeks > 1 ? 's' : ''}, ta forme de fond est passée de ${whole(first.ctl)} à ${whole(now.ctl)}.`,
    `Aujourd’hui : fatigue ${whole(now.atl)}, forme ${signed(now.tsb)}.`,
  ];
  const race = curve.race_day;
  const end = curve.series[curve.series.length - 1];
  if (curve.goal_id != null && end && race?.ctl != null && race.tsb != null) {
    if (planReachesRaceWeek(curve, end.date))
      parts.push(`Projection le jour J : forme de fond ${whole(race.ctl)}, forme ${formBand(race.tsb, daysBetween(curve.today, end.date))}.`);
    else parts.push(`${plannedUntil(curve.last_planned)}, la courbe suppose du repos ensuite.`);
  }
  return parts.join(' ');
}

/** "Plan jusqu'au 28 oct." or "Aucune séance prévue": what the projection rests on. */
export function plannedUntil(lastPlanned: string | null): string {
  if (!lastPlanned) return 'Aucune séance prévue d’ici la course';
  const day = new Date(`${lastPlanned}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `Plan jusqu’au ${day}`;
}

const daysBetween = (from: string, to: string) => Math.round((parseDay(to) - parseDay(from)) / 86_400_000);

const parseDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
