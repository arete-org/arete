import type { Renegotiated, RenegotiationGarmin, RenegotiationReason } from '@/types';

/** What the athlete chose and what the server did with it. */
export interface Renegotiation {
  result: Renegotiated;
  option: RenegotiationReason['options'][number];
}

/** The day's panel message: the written change, then Garmin's part apart. */
export interface DayOutcome {
  headline: string;
  garmin: RenegotiationGarmin;
  /** The session became a rest: a copy left on the watch is to be removed, not sent. */
  withdraw: boolean;
}

/** « jeudi 22 octobre », from an ISO day read at noon (no zone shifts it). */
export const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

export function renegotiationOutcome({ result, option }: Renegotiation): DayOutcome {
  const kind = result.decision.decision;
  const headline =
    kind === 'move'
      ? `Séance déplacée à ${dayLabel(result.date)}.`
      : kind === 'rest'
        ? 'Repos noté pour aujourd’hui.'
        : `Séance modifiée : ${option.detail}.`;
  return { headline, garmin: result.garmin, withdraw: kind === 'rest' };
}

/** « Rétablir »: the planned session back, Garmin reported as for a choice. */
export const revertOutcome = (
  garmin: RenegotiationGarmin | undefined,
  headline = 'Séance rétablie à aujourd’hui.',
): DayOutcome => ({ headline, garmin: garmin ?? 'unchanged', withdraw: false });

/** Garmin's line as the server reported it; nothing when Garmin held no copy. */
export function garminLine({ garmin, withdraw }: DayOutcome): string | null {
  switch (garmin) {
    case 'sent':
      return 'Garmin : la séance est à jour sur ta montre.';
    case 'withdrawn':
      return 'Garmin : la séance est retirée de ta montre.';
    case 'failed':
      return 'Garmin n’a pas confirmé la mise à jour, rien n’est renvoyé automatiquement : vérifie dans le Planning.';
    case 'not_started':
      return 'Garmin n’a pas été mis à jour à temps : vérifie la séance dans le Planning.';
    case 'disabled':
      return withdraw
        ? 'Ta montre a encore la séance (envoi automatique désactivé) : retire-la depuis le Planning.'
        : 'Ta montre a l’ancienne version (envoi automatique désactivé) : renvoie-la depuis le Planning.';
    case 'disconnected':
      return 'Garmin n’est pas connecté : ta montre n’a pas été mise à jour.';
    case 'unchanged':
      return null;
  }
}
