import type { CoachWords } from '@/lib/coachName';
import { DECISION_LABEL } from '@/lib/fr';
import { sessionTitle, STATE_LABELS } from '@/pages/planning/sessionForm';
import type { ActivityDetail, ActivitySummary, PlannedBrief } from '@/types';

/** Under this the first sentence says too little alone (« Bravo ! »): the next one joins it. */
const MIN_LEAD_CHARS = 40;

/** The text's first sentence (or line), and what follows it. */
export function leadSentence(text: string): [string, string] {
  const body = text.trim();
  let end = 0;
  while (end < body.length) {
    const stop = body.slice(end).search(/[.!?…](?=\s)|\n/);
    if (stop < 0) return [body, ''];
    end += stop + 1;
    if (end >= MIN_LEAD_CHARS || body[end - 1] === '\n') break;
  }
  return [body.slice(0, end).trim(), body.slice(end).trim()];
}

function plannedText(planned: PlannedBrief): string {
  const parts = [sessionTitle(planned)];
  if (planned.target_duration_min) parts.push(`${planned.target_duration_min} min`);
  if (planned.target_distance_km) parts.push(`${planned.target_distance_km.toLocaleString('fr-FR')} km`);
  if (planned.target_hr_zone) parts.push(planned.target_hr_zone);
  const text = parts.join(' · ');
  if (planned.status === 'skipped') return `${text} (${STATE_LABELS.skipped.toLowerCase()})`;
  if (planned.status === 'completed') return `${text} (${STATE_LABELS.done.toLowerCase()})`;
  return text;
}

const VERDICT: Record<NonNullable<NonNullable<ActivitySummary['plan']>['verdict']>, string> = {
  on_plan: 'conforme',
  shorter: 'plus court',
  longer: 'plus long',
  harder: 'plus intense',
  easier: 'plus facile',
};

/**
 * « Face au plan : conforme. 48 min au total pour 45 min prévues, FC 152 bpm pour une Z2 autour de 154 bpm. »
 * The measures the verdict read (duration_sec, avg_hr) against the plan's targets;
 * without a verdict, the planned session itself.
 */
export function planLine(
  plan: NonNullable<ActivitySummary['plan']>,
  session: Pick<ActivityDetail['session'], 'duration_sec' | 'avg_hr'>,
): { label: string; verdict: string | null; text: string; title: string; href: string } {
  const { planned } = plan;
  const parts: string[] = [];
  if (planned.target_duration_min) {
    parts.push(`${Math.round(session.duration_sec / 60)} min au total pour ${planned.target_duration_min} min prévues`);
  }
  if (planned.target_hr_zone && plan.target_hr_bpm && session.avg_hr) {
    parts.push(`FC ${Math.round(session.avg_hr)} bpm pour une ${planned.target_hr_zone.toUpperCase()} autour de ${plan.target_hr_bpm} bpm`);
  }
  return {
    label: plan.verdict ? 'Face au plan' : 'Séance prévue',
    verdict: plan.verdict ? VERDICT[plan.verdict] : null,
    text: parts.length ? `${parts.join(', ')}.` : `${plannedText(planned)}.`,
    title: sessionTitle(planned),
    // The planning's day, as the workout card links it.
    href: `/planning?date=${planned.date}&session=${planned.id}`,
  };
}

const weekday = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' });

/** « Demain : … » (or « Aujourd’hui : … » the morning after): the plan, and the coach's proposal on it. */
export function nextDayLine(
  nextDay: NonNullable<ActivitySummary['next_day']>,
  coach: CoachWords,
): { label: string; text: string; reasons: string[] } {
  const label = nextDay.relative === 'today' ? 'Aujourd’hui' : 'Demain';
  if (nextDay.planned.length === 0) {
    const text = nextDay.next
      ? `rien de prévu. Prochaine séance ${weekday(nextDay.next.date)} : ${plannedText(nextDay.next)}.`
      : 'rien de prévu au planning.';
    return { label, text, reasons: [] };
  }
  const reasons: string[] = [];
  const sessions = nextDay.planned.map((planned) => {
    const proposal = nextDay.proposals.find((p) => p.planned_session_id === planned.id);
    if (!proposal) return plannedText(planned);
    if (!reasons.includes(proposal.reason)) reasons.push(proposal.reason);
    const decision = (DECISION_LABEL[proposal.decision] ?? proposal.decision).toLowerCase();
    return proposal.state === 'applied'
      ? `${plannedText(planned)}, ${decision} (déjà appliquée)`
      : `${plannedText(planned)}, ${coach.the} propose : ${decision}`;
  });
  return { label, text: `${sessions.join(' ; ')}.`, reasons };
}
