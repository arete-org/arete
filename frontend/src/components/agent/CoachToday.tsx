import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, Panel } from '@/components/ui';
import { coachApi, coachTodayKey, discussWithCoach, type Followup, type Proposal, type SeenRevision } from '@/lib/coachToday';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';

function description(value: Record<string, unknown> | null) {
  if (!value) return 'Repos';
  const label: Record<string, string> = { endurance: 'Endurance', recovery: 'Récupération', tempo: 'Tempo', intervals: 'Fractionné', long_run: 'Sortie longue' };
  return [label[String(value.session_type)] ?? value.description ?? value.session_type, value.target_duration_min ? `${value.target_duration_min} min` : '', value.target_hr_zone].filter(Boolean).join(' · ');
}

function outcome(proposal: Proposal) {
  return proposal.decision === 'rest' ? 'Repos' : description({ ...proposal.original, ...proposal.adapted });
}

/** One card for the day: the athlete answers for every open proposal (`members`) at once. */
export function ProposalCard({ proposal, group, members }: { proposal: Proposal; group: Proposal[]; members: SeenRevision[] }) {
  const client = useQueryClient();
  const [uncertain, setUncertain] = useState(false);
  const others = members.filter(m => m.id !== proposal.id);
  const action = useMutation({
    mutationFn: (choice: 'apply' | 'keep' | 'snooze') => coachApi.proposal(proposal.id, proposal.revision, choice, others),
    // The dashboard's refresh brings the card back (invalidateAfterSession).
    onSuccess: () => invalidateAfterSession(client),
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
  return <article className="space-y-3 rounded-xl border border-neon-cyan/25 bg-neon-cyan/5 p-4">
    <p className="text-xs uppercase tracking-wide text-neon-cyan">{stale ? 'Proposition périmée' : 'Proposition'} · {proposal.date}</p>
    {group.length > 1 ? <>
      <p className="font-semibold">{discussion ? 'Examiner les étapes ensemble' : 'Proposé pour la journée'}</p>
      <ul className="space-y-1 text-sm">{group.map(p => <li key={p.id}>{description(p.original)} → {outcome(p)}</li>)}</ul>
    </> : <>
      <p className="text-sm text-text-secondary">Prévu : {description(proposal.original)}</p>
      <p className="font-semibold">{discussion ? 'Examiner les étapes ensemble' : `Proposé : ${outcome(proposal)}`}</p>
    </>}
    <p className="text-sm text-text-secondary">{proposal.reason}</p>
    <p className="text-xs text-text-muted">{proposal.readiness_measured_on ? `Mesure de récupération du ${proposal.readiness_measured_on}` : 'Récupération estimée par la charge'} · Rien n’a encore changé.</p>
    <div className="flex flex-wrap gap-2">
      {!discussion && <Button disabled={disabled || stale} onClick={() => action.mutate('apply')}>Appliquer</Button>}
      <Button variant="ghost" disabled={disabled} onClick={() => action.mutate('keep')}>Garder ma séance</Button>
      <Button variant="ghost" onClick={() => discussWithCoach({ kind: 'proposal', id: proposal.id })}>En parler</Button>
      <Button variant="ghost" disabled={disabled} onClick={() => action.mutate('snooze')}>Pas maintenant</Button>
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
export function CoachTodayPanel({ briefing, briefingNote, enabled = true, refetchOnFocus = true }: { briefing?: string; briefingNote?: string; enabled?: boolean; refetchOnFocus?: boolean }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: coachTodayKey, queryFn: coachApi.today, enabled, refetchOnWindowFocus: refetchOnFocus });
  const prepare = useMutation({ mutationFn: coachApi.prepare, onSuccess: data => client.setQueryData(coachTodayKey, data) });
  return <Panel title="Avec Chiron aujourd’hui">
    <div className="space-y-3">
      {query.isPending && <p role="status">Chargement du suivi…</p>}
      {(query.error || prepare.error) && <p role="alert" className="text-sm text-danger-red">{readableError(query.error ?? prepare.error)}</p>}
      {query.data?.items.map(item => item.kind === 'proposal' ? <ProposalCard key={`p:${item.record.id}`} proposal={item.record} group={item.group} members={item.members} /> : <FollowupCard key={`f:${item.record.id}`} followup={item.record} />)}
      {(briefing || query.data?.briefing) && <p className="text-sm text-text-secondary">{briefing || query.data?.briefing?.text}</p>}
      {briefing && briefingNote && <p className="text-xs text-text-muted">{briefingNote}</p>}
      {!!query.data?.remaining && <p className="text-xs text-text-muted">{query.data.remaining} autre(s) point(s) à examiner après ceux-ci.</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="ghost" aria-describedby="coach-prepare-hint" disabled={prepare.isPending} onClick={() => prepare.mutate()}>{prepare.isPending ? 'Actualisation…' : 'Actualiser le suivi'}</Button>
        <p id="coach-prepare-hint" className="text-xs text-text-muted">Relit ta récupération et tes dernières séances pour proposer une adaptation ou une question. Rien ne change sans ton accord.</p>
      </div>
    </div>
  </Panel>;
}
