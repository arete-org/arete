import type { ActivityDetail } from '@/types';
import { isFootSport } from '@/lib/activity';
import { formatDecimal } from '@/lib/fr';
import type { GlossaryId } from '@/lib/glossary';
import { formatKg } from '@/lib/strengthProgress';
import { formatDurationCompact, formatPace } from '@/lib/utils';

/** One number of the session's summary: always with its unit. */
export interface SummaryNumber {
  label: string;
  value: string;
  /** A second line: the comparison and its period, or a related value. */
  detail?: string;
  term?: GlossaryId;
}

export type SummaryKind = 'run' | 'intervals' | 'walk' | 'ride' | 'swim' | 'strength' | 'other';

/** The slope changed the effort by this fraction at least (activity_detail.GAP_NOTABLE). */
const GAP_NOTABLE = 0.03;
const SHOWN = 3;

/** Which three numbers a session leads with: by sport, then by its detected structure. */
export function summaryKind(detail: ActivityDetail): SummaryKind {
  const sport = detail.session.sport.toLowerCase();
  if (sport.includes('strength') || sport.includes('weight_training') || sport.includes('musculation')) return 'strength';
  if (sport.includes('walk') || sport.includes('hik')) return 'walk';
  if (isFootSport(sport)) return detail.intervals ? 'intervals' : 'run';
  if (sport.includes('swim')) return 'swim';
  if (sport.includes('cycl') || sport.includes('ride') || sport.includes('bik')) return 'ride';
  return 'other';
}

/** "4 min", "1 min 30 s", "45 s": a rep's length read aloud. */
function spokenDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (!m) return `${s} s`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

const shortDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

type Pick = (detail: ActivityDetail) => SummaryNumber | null;

const distanceKm: Pick = ({ session }) =>
  session.distance_m ? { label: 'Distance', value: `${formatDecimal(session.distance_m / 1000, 2)} km` } : null;

const distanceM: Pick = ({ session }) =>
  session.distance_m ? { label: 'Distance', value: `${Math.round(session.distance_m).toLocaleString('fr-FR')} m` } : null;

const duration: Pick = ({ session }) => {
  const seconds = session.moving_time_sec ?? session.duration_sec;
  return seconds ? { label: 'Durée', value: formatDurationCompact(seconds) } : null;
};

const pace: Pick = ({ session, terrain }) => {
  if (!session.avg_pace_sec_km) return null;
  const hilly = terrain?.gap_sec_km && terrain.grade_factor !== null && Math.abs(terrain.grade_factor - 1) >= GAP_NOTABLE;
  return {
    label: 'Allure moyenne',
    value: `${formatPace(session.avg_pace_sec_km)} /km`,
    detail: hilly ? `GAP ${formatPace(terrain.gap_sec_km!)} /km` : undefined,
    term: hilly ? 'gap' : 'allure',
  };
};

const heartRate: Pick = ({ session }) =>
  session.avg_hr ? { label: 'FC moyenne', value: `${Math.round(session.avg_hr)} bpm` } : null;

const rpe: Pick = ({ session }) =>
  session.rpe != null ? { label: 'Effort ressenti', value: `${session.rpe}/10`, term: 'rpe' } : null;

/** The heart when it was recorded, else what the athlete felt. */
const heartOrRpe: Pick = (detail) => heartRate(detail) ?? rpe(detail);

const reps: Pick = ({ intervals }) =>
  intervals
    ? {
        label: 'Fractionné',
        value: `${intervals.count} × ${spokenDuration(intervals.work_avg_sec)}`,
        detail: intervals.rest_avg_sec ? `récup ${spokenDuration(intervals.rest_avg_sec)}` : undefined,
      }
    : null;

/** The work reps' own pace: their distance over their time. */
const repPace: Pick = ({ intervals }) => {
  const done = (intervals?.work ?? []).filter((rep) => rep.distance_m && rep.duration_sec);
  const metres = done.reduce((sum, rep) => sum + (rep.distance_m ?? 0), 0);
  const seconds = done.reduce((sum, rep) => sum + rep.duration_sec, 0);
  return metres > 0 ? { label: 'Allure des répétitions', value: `${formatPace((seconds / metres) * 1000)} /km`, term: 'allure' } : null;
};

const ascent: Pick = ({ session }) =>
  session.ascent_m ? { label: 'Dénivelé +', value: `${Math.round(session.ascent_m).toLocaleString('fr-FR')} m` } : null;

const speedOrPower: Pick = ({ session }) => {
  if (session.avg_watts) return { label: 'Puissance moyenne', value: `${Math.round(session.avg_watts)} W` };
  return session.avg_speed_mps ? { label: 'Vitesse moyenne', value: `${formatDecimal(session.avg_speed_mps * 3.6, 1)} km/h` } : null;
};

const swimPace: Pick = ({ session }) => {
  const seconds = session.moving_time_sec ?? session.duration_sec;
  if (!session.distance_m || !seconds) return null;
  return { label: 'Allure moyenne', value: `${formatPace((seconds / session.distance_m) * 100)} /100 m` };
};

const calories: Pick = ({ session }) => (session.calories ? { label: 'Calories', value: `${session.calories} kcal` } : null);

/** Bodyweight work lifts no load: no tonnage, a fallback takes its place. */
const tonnage: Pick = ({ summary }) =>
  summary.strength && summary.strength.tonnage_kg > 0
    ? { label: 'Tonnage', value: formatKg(summary.strength.tonnage_kg), detail: 'séries de travail' }
    : null;

const sets: Pick = ({ summary }) =>
  summary.strength
    ? { label: 'Séries', value: `${summary.strength.sets} série${summary.strength.sets > 1 ? 's' : ''}`, detail: 'hors échauffement' }
    : null;

/** The best 1RM estimate of the session against that lift's previous session. */
const topLift: Pick = ({ summary }) => {
  const top = summary.strength?.top_e1rm;
  if (!top) return null;
  const label = `1RM estimé · ${top.exercise}`;
  if (top.previous_kg == null || !top.previous_date) return { label, value: formatKg(top.e1rm_kg), detail: 'première mesure' };
  const change = Math.round((top.e1rm_kg - top.previous_kg) * 10) / 10;
  const since = `vs ${shortDate(top.previous_date)}`;
  // An unchanged lift is no « 0 kg »: the value stays the 1RM itself.
  if (change === 0) return { label, value: formatKg(top.e1rm_kg), detail: `stable ${since}` };
  return {
    label,
    value: `${formatDecimal(change, Number.isInteger(change) ? 0 : 1, true)} kg`,
    detail: `${formatKg(top.e1rm_kg)} · ${since}`,
  };
};

/** The preferred numbers per kind, then what stands in when one is missing. */
const PICKS: Record<SummaryKind, Pick[]> = {
  run: [distanceKm, pace, heartOrRpe],
  intervals: [reps, repPace, heartOrRpe],
  walk: [distanceKm, ascent, duration],
  ride: [distanceKm, speedOrPower, heartOrRpe],
  swim: [distanceM, swimPace, duration],
  strength: [tonnage, sets, topLift],
  other: [duration, heartOrRpe, calories],
};
const FALLBACK: Pick[] = [duration, distanceKm, heartRate, rpe, calories];

/**
 * The three numbers that matter for this session, each with its unit. Missing
 * values give way to the fallbacks, never to a dash; a session with less to
 * say shows fewer numbers.
 */
export function summaryNumbers(detail: ActivityDetail): SummaryNumber[] {
  const shown: SummaryNumber[] = [];
  for (const pick of [...PICKS[summaryKind(detail)], ...FALLBACK]) {
    const number = pick(detail);
    if (number && !shown.some((other) => other.label === number.label)) shown.push(number);
    if (shown.length === SHOWN) break;
  }
  return shown;
}
