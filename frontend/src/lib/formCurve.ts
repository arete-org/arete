import { useEffect, useState, type RefObject } from 'react';
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

/** True once `ref` is on screen; where IntersectionObserver is missing, at once. */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
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

/** "entre +3 et +13": the projection is a model, so a band, never a false decimal. */
export const FORM_BAND = 5;
export function formBand(tsb: number): string {
  const centre = Math.round(tsb);
  return `entre ${formatDecimal(centre - FORM_BAND, 0, true)} et ${formatDecimal(centre + FORM_BAND, 0, true)}`;
}

const whole = (value: number) => formatDecimal(Math.round(value), 0);
const signed = (value: number) => formatDecimal(Math.round(value), 0, true);

/**
 * The curve in words, for screen readers and a phone at a glance: where the
 * forme de fond went over the weeks shown, today's fatigue and forme, and
 * race morning when a race is projected.
 */
export function curveSummary(curve: FormCurve): string {
  const history = curve.series.filter((p) => !p.planned && p.date <= curve.today);
  const first = history[0];
  const now = history[history.length - 1];
  if (!first || !now) return 'Pas encore de charge enregistrée : la courbe apparaîtra avec tes premières séances.';
  const weeks = Math.max(1, Math.round((parseDay(now.date) - parseDay(first.date)) / (7 * 86_400_000)));
  const parts = [
    `Sur ${weeks} semaine${weeks > 1 ? 's' : ''}, ta forme de fond est passée de ${whole(first.ctl)} à ${whole(now.ctl)}.`,
    `Aujourd’hui : fatigue ${whole(now.atl)}, forme ${signed(now.tsb)}.`,
  ];
  const race = curve.race_day;
  if (curve.goal_id != null && race?.ctl != null && race.tsb != null)
    parts.push(`Projection le jour J : forme de fond ${whole(race.ctl)}, forme ${formBand(race.tsb)}.`);
  return parts.join(' ');
}

const parseDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
