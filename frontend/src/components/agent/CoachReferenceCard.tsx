import { useQuery } from '@tanstack/react-query';
import { AthleteFactsPanel } from '@/pages/settings/AthleteFactsPanel';
import { coachApi } from '@/lib/coachToday';
import { FollowupCard } from './CoachToday';
import type { CoachCardPart } from '@/lib/agentStream';

function FollowupReference({ id }: { id: number }) {
  const query = useQuery({ queryKey: ['coachFollowup', id], queryFn: () => coachApi.followup(id) });
  if (query.isPending) return <p role="status">Chargement du suivi…</p>;
  if (query.isError) return <p role="alert">Suivi indisponible. <button className="underline" onClick={() => void query.refetch()}>Réessayer</button></p>;
  return <FollowupCard followup={query.data} />;
}
export function CoachReferenceCard({ reference }: { reference: CoachCardPart }) {
  return reference.ref_kind === 'fact' ? <AthleteFactsPanel factId={reference.ref_id} /> : <FollowupReference id={reference.ref_id} />;
}
