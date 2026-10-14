/** Shared French labels for values the backend sends as snake_case enums. */

/** Metric families whose zone values share spellings ("optimal", "high"…). */
export type ZoneKind = 'acwr' | 'form' | 'readiness' | 'monotony' | 'strain';

/** French labels keyed by the backend's exact values (features/workload.py, features/fitness.py). */
export const ZONE_LABEL: Record<ZoneKind, Record<string, string>> = {
  acwr: {
    undertrained: 'charge basse',
    optimal: 'optimale',
    caution: 'prudence',
    danger: 'zone à risque',
  },
  form: {
    freshest: 'très frais',
    fresh: 'frais',
    neutral: 'neutre',
    tired: 'fatigué',
    exhausted: 'épuisé',
  },
  readiness: {
    optimal: 'optimale',
    good: 'bonne',
    moderate: 'moyenne',
    low: 'faible',
    critical: 'critique',
  },
  monotony: {
    ideal: 'idéale',
    acceptable: 'correcte',
    high: 'élevée',
  },
  strain: {
    low: 'faible',
    optimal: 'optimale',
    high: 'élevée',
    critical: 'critique',
  },
};

export const zoneLabel = (kind: ZoneKind, zone: string | null | undefined): string =>
  !zone || zone === 'unknown' ? 'inconnu' : (ZONE_LABEL[kind][zone] ?? zone.replace(/_/g, ' '));

/** "7h12" from seconds, for sleep durations. */
export function formatHoursMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  return m === 60 ? `${h + 1}h00` : `${h}h${String(m).padStart(2, '0')}`;
}

/** Backend sport strings (Garmin and Strava spellings) to French labels. */
export const SPORT_LABEL: Record<string, string> = {
  run: 'Course',
  running: 'Course',
  trail_run: 'Trail',
  trail_running: 'Trail',
  treadmill_running: 'Tapis',
  virtual_run: 'Course virtuelle',
  virtualrun: 'Course virtuelle',
  ride: 'Vélo',
  cycling: 'Vélo',
  virtual_ride: 'Home-trainer',
  indoor_cycling: 'Vélo intérieur',
  mountain_biking: 'VTT',
  swim: 'Natation',
  swimming: 'Natation',
  lap_swimming: 'Natation',
  strength: 'Musculation',
  strength_training: 'Musculation',
  weight_training: 'Musculation',
  walk: 'Marche',
  walking: 'Marche',
  hike: 'Randonnée',
  hiking: 'Randonnée',
  rowing: 'Rameur',
  indoor_rowing: 'Rameur',
  yoga: 'Yoga',
  mobility: 'Mobilité',
  cardio: 'Cardio',
  other: 'Autre',
};

export const sportLabel = (sport: string | null | undefined): string =>
  sport ? (SPORT_LABEL[sport.toLowerCase()] ?? sport.replace(/_/g, ' ')) : 'Autre';

/** The morning adaptation's decisions (services/adaptation.py). */
export const DECISION_LABEL: Record<string, string> = {
  keep: 'Maintenue',
  ease: 'Allégée',
  replace_easy: 'Remplacée',
  rest: 'Repos',
};

/** "08:05" in the browser's time zone, from an ISO timestamp. */
export const formatClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Periodisation phases of a generated plan (features/plan_generator.py). */
export const PHASE_LABEL: Record<string, string> = {
  base: 'Base',
  build: 'Développement',
  specific: 'Spécifique',
  taper: 'Affûtage',
  race: 'Course',
};

export const phaseLabel = (phase: string): string => PHASE_LABEL[phase] ?? phase;

/** Kinds of durable athlete facts (services/athlete_facts.py). */
export const FACT_KIND_LABEL: Record<string, string> = {
  injury: 'blessure',
  constraint: 'contrainte',
  preference: 'préférence',
  goal: 'objectif',
  other: 'autre',
};

/**
 * "9 des 12 dernières semaines à l’objectif de charge": the regularity a missed
 * week lowers by one. The goal is the weekly load (TSS), not a session count.
 */
export function weeksAtGoalText(hit: number, weeks: number): string {
  if (weeks === 1) return hit ? 'Dernière semaine à l’objectif de charge' : 'Dernière semaine sous l’objectif de charge';
  return `${hit} des ${weeks} dernières semaines à l’objectif de charge`;
}

/** "1,12", "+4,2": French decimals with a fixed precision; `signed` marks a positive value. */
export function formatDecimal(value: number, digits: number, signed = false): string {
  return value.toLocaleString('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: signed ? 'exceptZero' : 'auto',
  });
}
