import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RenegotiationOutcome } from '@/components/dashboard/RenegotiationOutcome';
import type { DayOutcome } from '@/lib/renegotiation';
import { AthleteFactsPanel } from '@/pages/settings/AthleteFactsPanel';
import { coachApi, coachTodayKey } from '@/lib/coachToday';
import { FollowupCard, ProposalCard } from './CoachToday';
import type { CoachCardPart } from '@/lib/agentStream';

export function FollowupReference({ id }: { id: number }) {
  const query = useQuery({ queryKey: ['coachFollowup', id], queryFn: () => coachApi.followup(id) });
  if (query.isPending) return <p role="status">Chargement du suivi…</p>;
  if (query.isError)
    return (
      <p role="alert">
        Suivi indisponible.{' '}
        <button className="underline" onClick={() => void query.refetch()}>
          Réessayer
        </button>
      </p>
    );
  return <FollowupCard followup={query.data} />;
}
export function ProposalReference({ id }: { id: number }) {
  const query = useQuery({ queryKey: coachTodayKey, queryFn: coachApi.today });
  const [receipt, setReceipt] = useState<{ id: number; outcome: DayOutcome } | null>(null);
  if (receipt?.id === id)
    return <RenegotiationOutcome outcome={receipt.outcome} onDismiss={() => setReceipt(null)} />;
  if (query.isPending) return <p role="status">Chargement de la proposition…</p>;
  if (query.isError)
    return (
      <p role="alert">
        Proposition indisponible.{' '}
        <button className="min-h-11 underline" onClick={() => void query.refetch()}>
          Réessayer
        </button>
      </p>
    );
  const item = query.data.items.find(
    (item) =>
      item.kind === 'proposal' &&
      (item.record.id === id || item.group.some((proposal) => proposal.id === id)),
  );
  return item?.kind === 'proposal' ? (
    <ProposalCard
      proposal={item.record}
      group={item.group}
      members={item.members}
      onAnswered={(outcome) => setReceipt(outcome ? { id, outcome } : null)}
    />
  ) : (
    <p role="status" className="text-sm text-text-muted">
      Cette proposition n’est plus en attente. Le planning affiche son état actuel.
    </p>
  );
}
export function CoachReferenceCard({ reference }: { reference: CoachCardPart }) {
  return reference.ref_kind === 'fact' ? (
    <AthleteFactsPanel factId={reference.ref_id} />
  ) : (
    <FollowupReference id={reference.ref_id} />
  );
}
