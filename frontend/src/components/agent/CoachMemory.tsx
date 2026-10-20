import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronRight } from 'lucide-react';
import { athleteFactsApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { AthleteFactsPanel } from '@/pages/settings/AthleteFactsPanel';
import type { AthleteFact } from '@/types';
import { OnboardingContext } from './OnboardingContext';
import { useCoachName } from '@/lib/coachName';

function MemoryRows({ facts }: { facts: AthleteFact[] }) {
  return <ul className="divide-y divide-text-muted/15">{facts.map(fact => <li key={fact.id}>
    <details className="group/memory py-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 break-words">{fact.text}<span className="mt-1 block text-xs text-text-muted">{fact.status === 'resolved' ? 'Désactivé' : fact.evidence === 'hypothesis' ? 'À confirmer ensemble' : fact.valid_until ? `Jusqu’au ${new Date(`${fact.valid_until}T12:00:00`).toLocaleDateString('fr-FR')}` : 'Déclaration de ta part'}</span></span>
        <ChevronRight className="size-4 shrink-0 text-text-muted transition-transform group-open/memory:rotate-90 motion-reduce:transition-none" />
      </summary>
      <AthleteFactsPanel factId={fact.id} embedded />
    </details>
  </li>)}</ul>;
}

export function CoachMemory({ factIds }: { factIds?: number[] }) {
  const coach = useCoachName();
  const query = useQuery({ queryKey: qk.athleteFacts, queryFn: athleteFactsApi.list, refetchOnMount: 'always' });
  if (query.isPending) return <p role="status" className="py-2 text-xs text-text-muted">Chargement de la mémoire…</p>;
  if (query.isError) return <p role="alert" className="py-2 text-xs text-danger-red">Mémoire indisponible. <button className="min-h-11 underline" onClick={() => void query.refetch()}>Réessayer</button></p>;
  const facts = factIds ? query.data.filter(f => factIds.includes(f.id)) : query.data;
  return <>{!factIds && <OnboardingContext hideEmpty />}{facts.length ? <MemoryRows facts={facts} /> : <p className="py-3 text-sm text-text-muted">{factIds ? 'Ce souvenir a été oublié.' : `Aucun autre souvenir enregistré. Tu peux partager tes habitudes avec ${coach}.`}</p>}</>;
}

/** One disclosure per answer, even when several writes/duplicates were streamed.
 * The IDs survive reload; their content and current state always come from the server. */
export function MemoryReceipt({ factIds }: { factIds: number[] }) {
  const [open, setOpen] = useState(false);
  return <div className="mt-2 text-xs text-text-muted">
    <button aria-label="Voir la mémoire mise à jour" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex min-h-11 items-center gap-2 rounded px-1 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-neon-cyan">
      <Check aria-hidden="true" className="size-3.5" /> Mémoire mise à jour <span aria-hidden="true">·</span> {open ? 'Masquer' : 'Voir'}
    </button>
    {open && <CoachMemory factIds={[...new Set(factIds)]} />}
  </div>;
}
