import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RenegotiationOutcome } from '@/components/dashboard/RenegotiationOutcome';
import { Button, Panel } from '@/components/ui';
import { coachApi, coachTodayKey, discussWithCoach, type Followup, type Proposal, type SeenRevision } from '@/lib/coachToday';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { dayLabel, type DayOutcome } from '@/lib/renegotiation';
import { readableError } from '@/lib/utils';

function description(value: Record<string, unknown> | null) {
  if (!value) return 'Repos';
  const label: Record<string, string> = { endurance: 'Endurance', recovery: 'Récupération', tempo: 'Tempo', intervals: 'Fractionné', long_run: 'Sortie longue' };
  return [label[String(value.session_type)] ?? value.description ?? value.session_type, value.target_duration_min ? `${value.target_duration_min} min` : '', value.target_hr_zone].filter(Boolean).join(' · ');
}

const movedTo = (proposal: Proposal) =>
  typeof proposal.adapted?.date === 'string' ? proposal.adapted.date : null;

function outcome(proposal: Proposal) {
  if (proposal.decision === 'rest') return 'Repos';
  if (proposal.decision === 'drop') return 'Laissée de côté';
  const to = movedTo(proposal);
  if (proposal.decision === 'move' && to) return `Déplacée à ${dayLabel(to)}`;
  return description({ ...proposal.original, ...proposal.adapted });
}

/** What the panel says once the card is answered, Garmin's part apart. */
function answered(group: Proposal[], choice: 'apply' | 'keep' | 'snooze', garmin: DayOutcome['garmin'] | undefined): DayOutcome | null {
  const missed = group.every(p => p.readiness_source === 'missed');
  const lead = group[0];
  if (choice === 'snooze') return null;
  if (choice === 'keep') return { headline: missed ? 'C’est noté : rien ne change.' : 'C’est noté : ta séance reste prévue.', garmin: 'unchanged', withdraw: false };
  const to = movedTo(lead);
  const headline = group.length > 1
    ? 'Proposition appliquée.'
    : lead.decision === 'move' && to
      ? `Séance déplacée à ${dayLabel(to)}.`
      : lead.decision === 'drop'
        ? 'Séance laissée de côté.'
        : 'Proposition appliquée.';
  return { headline, garmin: garmin ?? 'unchanged', withdraw: lead.decision === 'drop' || lead.decision === 'rest' };
}

/** One card for the day: the athlete answers for every open proposal (`members`) at once. */
export function ProposalCard({
  proposal,
  group,
  members,
  onAnswered,
}: {
  proposal: Proposal;
  group: Proposal[];
  members: SeenRevision[];
  /** The answer is written: the panel reports it (the card leaves). */
  onAnswered?: (outcome: DayOutcome | null) => void;
}) {
  const client = useQueryClient();
  const [uncertain, setUncertain] = useState(false);
  const others = members.filter(m => m.id !== proposal.id);
  // The evening's replanning of a missed session (ARE-61): its own words, no « Pas maintenant ».
  const missed = group.every(p => p.readiness_source === 'missed');
  const action = useMutation({
    mutationFn: (choice: 'apply' | 'keep' | 'snooze') => coachApi.proposal(proposal.id, proposal.revision, choice, others),
    // The dashboard's refresh brings the card back (invalidateAfterSession).
    onSuccess: (result, choice) => {
      onAnswered?.(answered(group, choice, result.garmin));
      invalidateAfterSession(client);
      // Its own key too: a dashboard read stamped no later than the card's own skips seeding it.
      void client.invalidateQueries({ queryKey: coachTodayKey });
    },
    onError: () => setUncertain(true),
  });
  // A read of its own: the card's query may be waiting for the dashboard.
  const check = async () => {
    try {
      await client.fetchQuery({ queryKey: coachTodayKey, queryFn: coachApi.today, staleTime: 0 });
      setUncertain(false);
      action.reset();
    } catch {
      // Still unknown: the button stays.
    }
  };
  const stale = group.some(p => p.state === 'stale');
  const discussion = group.some(p => p.state === 'discussion');
  // A changed session only blocks applying; keeping or postponing writes no session.
  const disabled = action.isPending || uncertain;
  const applyLabel = missed && group.length === 1
    ? proposal.decision === 'move' ? 'Déplacer' : 'Laisser de côté'
    : 'Appliquer';
  return <article className="space-y-3 rounded-xl border border-neon-cyan/25 bg-neon-cyan/5 p-4">
    <p className="text-xs uppercase tracking-wide text-neon-cyan">{stale ? 'Proposition périmée' : missed ? 'Séance manquée' : 'Proposition'} · {proposal.date}</p>
    {group.length > 1 ? <>
      <p className="font-semibold">{discussion ? 'Examiner les étapes ensemble' : 'Proposé pour la journée'}</p>
      <ul className="space-y-1 text-sm">{group.map(p => <li key={p.id}>{description(p.original)} → {outcome(p)}</li>)}</ul>
    </> : <>
      <p className="text-sm text-text-secondary">Prévu : {description(proposal.original)}</p>
      <p className="font-semibold">{discussion ? 'Examiner les étapes ensemble' : `Proposé : ${outcome(proposal)}`}</p>
    </>}
    <p className="text-sm text-text-secondary">{proposal.reason}</p>
    <p className="text-xs text-text-muted">{missed ? 'Aucune activité enregistrée aujourd’hui' : proposal.readiness_measured_on ? `Mesure de préparation du ${proposal.readiness_measured_on}` : 'Préparation estimée par la charge'} · Rien n’a encore changé.</p>
    {/* 44 px targets: the card is answered with a thumb. */}
    <div className="flex flex-wrap gap-2 [&>button]:min-h-11">
      {!discussion && <Button disabled={disabled || stale} onClick={() => action.mutate('apply')}>{applyLabel}</Button>}
      <Button variant="ghost" disabled={disabled} onClick={() => action.mutate('keep')}>{missed ? 'Non merci' : 'Garder ma séance'}</Button>
      <Button variant="ghost" onClick={() => discussWithCoach({ kind: 'proposal', id: proposal.id })}>En parler</Button>
      {!missed && <Button variant="ghost" disabled={disabled} onClick={() => action.mutate('snooze')}>Pas maintenant</Button>}
    </div>
    {action.isPending && <p role="status">Enregistrement…</p>}
    {action.error && <p role="alert" className="text-sm text-danger-red">{readableError(action.error)} Le résultat doit être vérifié avant une nouvelle action.</p>}
    {uncertain && <Button variant="ghost" onClick={() => void check()}>Vérifier l’état</Button>}
  </article>;
}

export function FollowupCard({ followup }: { followup: Followup }) {
  const client = useQueryClient();
  const [rpe, setRpe] = useState('');
  const [notes, setNotes] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const action = useMutation({
    mutationFn: (choice: 'answer' | 'skip' | 'snooze') => coachApi.respond(followup.id, followup.revision, choice, choice === 'answer' ? Number(rpe) : undefined, choice === 'answer' && notes.trim() ? notes.trim() : undefined),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['coachFollowup', followup.id] }); invalidateAfterSession(client); },
    onError: () => setUncertain(true),
  });
  const checked = useQuery({ queryKey: ['coachFollowup', followup.id], queryFn: () => coachApi.followup(followup.id), enabled: false });
  const current = action.data ?? checked.data ?? followup;
  const check = async () => { const result = await checked.refetch(); if (result.isSuccess) { setUncertain(false); action.reset(); await client.invalidateQueries({ queryKey: coachTodayKey }); } };
  if (current.state !== 'pending') return <p role="status" className="p-3 text-sm">{current.state === 'answered' ? `Ressenti enregistré : ${current.rpe}/10${current.notes ? ` — ${current.notes}` : ''}` : 'Suivi passé.'}</p>;
  return <article className="rounded-xl border border-text-muted/20 p-4 space-y-3">
    <p className="text-xs uppercase tracking-wide text-neon-purple">Pour mieux te connaître</p>
    <p className="font-semibold">{current.question}</p>
    <Link className="text-sm text-neon-cyan underline" to={`/log/sessions/${current.session_id}`}>Voir la séance</Link>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); action.mutate('answer'); }}>
      <label className="block text-sm">Effort ressenti · 1 très facile, 10 maximal
        <select required aria-label="Effort ressenti" value={rpe} onChange={e => setRpe(e.target.value)} className="mt-2 block w-full rounded border border-text-muted/30 bg-abyss p-3"><option value="">Choisir</option>{Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}/10</option>)}</select>
      </label>
      <label className="block text-sm">Une précision ? <span className="text-text-muted">Facultatif</span><textarea aria-label="Note de séance" maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} className="mt-2 block w-full rounded border border-text-muted/30 bg-abyss p-3" /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!rpe || action.isPending || uncertain}>Enregistrer</Button>
        <Button type="button" variant="ghost" disabled={action.isPending || uncertain} onClick={() => action.mutate('skip')}>Passer</Button>
        <Button type="button" variant="ghost" disabled={action.isPending || uncertain} onClick={() => action.mutate('snooze')}>Pas maintenant</Button>
        <Button type="button" variant="ghost" onClick={() => discussWithCoach({ kind: 'followup', id: current.id })}>En parler</Button>
      </div>
    </form>
    {action.error && <p role="alert" className="text-sm text-danger-red">{readableError(action.error)}</p>}
    {uncertain && <Button variant="ghost" onClick={() => void check()}>Vérifier l’état</Button>}
  </article>;
}

/**
 * `enabled: false` waits for another request to seed the card (the dashboard's);
 * `refetchOnFocus: false` leaves a focus refresh to that request.
 */
export function CoachTodayPanel({ enabled = true, refetchOnFocus = true }: { enabled?: boolean; refetchOnFocus?: boolean }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: coachTodayKey, queryFn: coachApi.today, enabled, refetchOnWindowFocus: refetchOnFocus });
  const prepare = useMutation({ mutationFn: coachApi.prepare, onSuccess: data => client.setQueryData(coachTodayKey, data) });
  // The last answer, which takes the focus as its card leaves.
  const [outcome, setOutcome] = useState<DayOutcome | null>(null);
  return <Panel title="Avec Chiron aujourd’hui">
    <div className="space-y-3">
      {outcome && <RenegotiationOutcome outcome={outcome} onDismiss={() => setOutcome(null)} />}
      {query.isPending && <p role="status">Chargement du suivi…</p>}
      {(query.error || prepare.error) && <p role="alert" className="text-sm text-danger-red">{readableError(query.error ?? prepare.error)}</p>}
      {query.data?.items.map(item => item.kind === 'proposal' ? <ProposalCard key={`p:${item.record.id}`} proposal={item.record} group={item.group} members={item.members} onAnswered={setOutcome} /> : <FollowupCard key={`f:${item.record.id}`} followup={item.record} />)}
      {!!query.data?.remaining && <p className="text-xs text-text-muted">{query.data.remaining} autre(s) point(s) à examiner après ceux-ci.</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="outline" size="sm" aria-describedby="coach-prepare-hint" disabled={prepare.isPending} onClick={() => prepare.mutate()}>{prepare.isPending ? 'Actualisation…' : 'Actualiser le suivi'}</Button>
        <p id="coach-prepare-hint" className="text-xs text-text-muted">Chiron relit ta récupération et tes dernières séances pour proposer une adaptation ou une question. Rien ne change sans ton accord.</p>
      </div>
    </div>
  </Panel>;
}
