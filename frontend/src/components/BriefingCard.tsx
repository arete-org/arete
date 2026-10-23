import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, BookOpen, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AgentMarkdown } from '@/components/agent/AgentMarkdown';
import { AreteMark, AretePresence } from '@/components/AreteBrand';
import { PushOffer } from '@/components/PushOffer';
import { Button } from '@/components/ui';
import { tipsApi, type DailyTip } from '@/lib/api';
import { discussWithCoach } from '@/lib/coachToday';
import { parseLocalDate } from '@/lib/dates';
import { frenchClock } from '@/lib/fr';
import { BRIEFING_READ_KEY, readFlag, writeFlag } from '@/lib/install';
import { qk } from '@/lib/queryKeys';
import { useCoachWords } from '@/lib/coachName';

/** Times remain visible when a sync replaces the day's recommendation. */
function briefingTimes(tip: DailyTip): string | null {
  const written = tip.first_written_at ?? tip.generated_at;
  if (!written) return null;
  const parts = [`Écrit à ${frenchClock(written)}`];
  if (tip.updated_after_sync && tip.generated_at) parts.push(`mis à jour après la synchro de ${frenchClock(tip.generated_at)}`);
  if (tip.source === 'rules') parts.push('calculé à partir de tes métriques');
  return parts.join(' · ');
}

function BriefingHistory({ onOpen }: { onOpen: () => void }) {
  const coach = useCoachWords();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: qk.tipHistory,
    queryFn: tipsApi.history,
    staleTime: 5 * 60_000,
  });
  if (isPending) return <p role="status" className="text-xs text-text-muted">Chargement des briefings…</p>;
  if (error) return <p role="alert" className="text-xs text-danger-red">Briefings indisponibles. <Button variant="ghost" onClick={() => void refetch()}>Réessayer</Button></p>;
  if (!data.length) return <p className="text-xs text-text-muted">Pas encore de briefing précédent.</p>;
  return <ol className="space-y-2 border-t border-text-muted/15 pt-3">
    {data.map(past => <li key={past.id}>
      <button type="button" className="briefing-history-link w-full text-left" onClick={() => { onOpen(); discussWithCoach({ kind: 'briefing', id: past.id }); }}>
        <span className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <span className="first-letter:uppercase">{parseLocalDate(past.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
        </span>
        <span className="mt-1 line-clamp-2 block text-sm leading-relaxed text-text-secondary">{past.tip}</span>
        <span className="sr-only">Ouvrir ce briefing dans une nouvelle conversation avec {coach.the}</span>
      </button>
    </li>)}
  </ol>;
}

/** Dashboard entry point. The conversation owns the full briefing and its feedback. */
export function BriefingCard({ tip, writing, stalled, refresh }: {
  tip: DailyTip | undefined;
  writing: boolean;
  stalled: boolean;
  refresh: () => void;
}) {
  const [history, setHistory] = useState(false);
  const coach = useCoachWords();
  // A briefing read on this device: the offer to receive it by push follows (ARE-131).
  const [read, setRead] = useState(() => readFlag(BRIEFING_READ_KEY) !== null);
  const markRead = () => { writeFlag(BRIEFING_READ_KEY, '1'); setRead(true); };
  const ready = !writing && !!tip?.tip && tip.id != null;
  const open = () => { if (ready) { markRead(); discussWithCoach({ kind: 'briefing', id: tip.id! }); } };
  const times = tip && briefingTimes(tip);
  return <section aria-label="Le point du coach" className="space-y-4 font-sans">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="flex items-center gap-2 text-sm font-medium text-text-primary"><AreteMark size={22} />Le point {coach.of}</span>
      <Button variant="ghost" size="sm" className="min-h-11" aria-expanded={history} onClick={() => setHistory(!history)}>Briefings précédents <ChevronDown aria-hidden="true" className="size-3.5" /></Button>
    </div>
    <h2 className="text-xl font-medium text-text-primary">Briefing du jour</h2>
    {writing ? <div role="status" className="flex items-center gap-2 text-sm text-text-muted">
      <AretePresence size={24} />{coach.The} écrit ton briefing…
      {stalled && <Button variant="ghost" className="ml-auto" onClick={refresh}>Actualiser</Button>}
    </div> : !tip?.tip ? <p className="text-sm text-danger-red">Briefing indisponible. <Button variant="ghost" onClick={refresh}>Réessayer</Button></p> : <>
      <div className="briefing-copy max-w-[65ch]"><AgentMarkdown text={tip.tip} /></div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {ready && <Button variant="outline" className="min-h-11" onClick={open}>{coach.discuss}</Button>}
        {times && <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-muted">{times}</p>}
        <Link to="/analytics/lexique" className="inline-flex min-h-11 items-center gap-1 text-xs text-text-muted hover:text-text-primary">
          <BookOpen aria-hidden="true" className="size-3.5" />Lexique
        </Link>
      </div>
    </>}
    {history && <BriefingHistory onOpen={markRead} />}
    {read && <PushOffer moment="briefing" />}
  </section>;
}
