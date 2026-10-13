import type { PlannedState } from '@/lib/sessionMatch';
import { ApiError, type PlannedSessionCreate } from '@/lib/api';
import type { Prescription } from '@/lib/documents';
import { SKIPPED_LAST_RECOVERY, stepAmount } from '@/lib/workouts';
import type { PlannedSession } from '@/types';

export const STATE_LABELS: Record<PlannedState, string> = {
  done: 'Réalisée',
  missed: 'Manquée',
  pending: 'Prévue',
  skipped: 'Sautée',
};

export const SPORTS = {
  running: 'Course',
  cycling: 'Vélo',
  swimming: 'Natation',
  strength: 'Musculation',
  walking: 'Marche',
  hiking: 'Randonnée',
  other: 'Autre',
};
export const SESSION_TYPES = {
  recovery: 'Récupération',
  endurance: 'Endurance',
  tempo: 'Seuil',
  intervals: 'Fractionné',
  long_run: 'Sortie longue',
  strength: 'Force',
  hypertrophy: 'Hypertrophie',
  power: 'Puissance',
  deload: 'Décharge',
  cross_training: 'Entraînement croisé',
  race: 'Compétition',
  other: 'Autre',
};
export const sessionTitle = (s: Pick<PlannedSession, 'description' | 'session_type'>) =>
  s.description || SESSION_TYPES[s.session_type as keyof typeof SESSION_TYPES] || 'Séance prévue';
export const sportLabel = (sport: string) => SPORTS[sport as keyof typeof SPORTS] ?? sport;
export const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

export function sessionDraft(date: string, session?: PlannedSession): PlannedSessionCreate {
  return {
    date,
    sport: session?.sport ?? 'running',
    session_type: session?.session_type ?? 'endurance',
    description: session?.description ?? '',
    source: 'manual',
    target_duration_min: session?.target_duration_min ?? undefined,
    target_distance_km: session?.target_distance_km ?? undefined,
    target_hr_zone: session?.target_hr_zone ?? undefined,
    target_intensity: session?.target_intensity ?? undefined,
    prescription: session?.prescription ? structuredClone(session.prescription) : null,
  };
}

export function saveFields(draft: PlannedSessionCreate) {
  return {
    date: draft.date,
    description: draft.description?.trim() ?? '',
    session_type: draft.session_type,
    prescription: draft.prescription,
    target_duration_min: draft.prescription ? 0 : (draft.target_duration_min ?? 0),
    target_distance_km: draft.prescription ? 0 : (draft.target_distance_km ?? 0),
    target_hr_zone: draft.prescription ? '' : (draft.target_hr_zone ?? ''),
    target_intensity: draft.prescription ? '' : (draft.target_intensity ?? ''),
  };
}

export const TEMPLATES: {
  label: string;
  sport: string;
  type: string;
  prescription: Prescription;
}[] = [
  {
    label: 'Endurance · 45 min',
    sport: 'running',
    type: 'endurance',
    prescription: {
      version: 1,
      steps: [{ kind: 'effort', duration_kind: 'seconds', value: 2700, steps: [] }],
    },
  },
  {
    label: 'Fractionné · 20 × 300 m',
    sport: 'running',
    type: 'intervals',
    prescription: {
      version: 1,
      steps: [
        { kind: 'warmup', duration_kind: 'lap', steps: [] },
        {
          kind: 'repeat',
          duration_kind: 'lap',
          repeat: 20,
          skip_last_recovery: true,
          steps: [
            { kind: 'effort', duration_kind: 'meters', value: 300, steps: [] },
            { kind: 'recovery', duration_kind: 'meters', value: 100, steps: [] },
          ],
        },
        { kind: 'cooldown', duration_kind: 'lap', steps: [] },
      ],
    },
  },
];

/** One meaningful work block gives the board useful density without fetching details. */
export function sessionSummary(
  session: Pick<
    PlannedSession,
    'prescription' | 'target_duration_min' | 'target_distance_km' | 'target_hr_zone'
  >,
): string {
  if (!session.prescription)
    return (
      [
        session.target_duration_min && `${session.target_duration_min} min`,
        session.target_distance_km && `${session.target_distance_km} km`,
        session.target_hr_zone,
      ]
        .filter(Boolean)
        .join(' · ') || 'Objectifs à préciser'
    );
  const steps = session.prescription.steps;
  const main =
    steps.find((step) => step.kind === 'repeat') ?? steps.find((step) => step.kind === 'effort');
  if (!main) return `${steps.length} étapes structurées`;
  if (main.kind !== 'repeat')
    return `${main.exercise ? `${main.exercise} · ` : ''}${stepAmount(main)}`;
  const effort = main.steps.find((step) => step.kind === 'effort');
  const recovery = main.steps.find((step) => step.kind === 'recovery' || step.kind === 'rest');
  const skipped = main.skip_last_recovery ? `, ${SKIPPED_LAST_RECOVERY}` : '';
  return `${main.repeat} × ${effort ? stepAmount(effort) : 'bloc'}${recovery ? ` · récup. ${stepAmount(recovery)}${skipped}` : ''}`;
}

export function planningError(error: Error | null): string {
  if (!error) return '';
  if (error instanceof ApiError)
    return (
      error.detail ??
      (error.status === 422
        ? 'Vérifie les champs et les étapes de la séance.'
        : 'La demande n’a pas abouti. Vérifie le planning avant de réessayer.')
    );
  return error.message;
}
