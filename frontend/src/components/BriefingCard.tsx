import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, BookOpen, ChevronDown, Sunrise } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AretePresence } from '@/components/AreteBrand';
import { PushOffer } from '@/components/PushOffer';
import { Button } from '@/components/ui';
import { tipsApi, type DailyTip } from '@/lib/api';
import { discussWithCoach } from '@/lib/coachToday';
import { parseLocalDate } from '@/lib/dates';
import { frenchClock } from '@/lib/fr';
import { BRIEFING_READ_KEY, readFlag, writeFlag } from '@/lib/install';
import { qk } from '@/lib/queryKeys';

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
        <span className="sr-only">Ouvrir ce briefing dans une nouvelle conversation avec Chiron</span>
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
  // A briefing read on this device: the offer to receive it by push follows (ARE-131).
  const [read, setRead] = useState(() => readFlag(BRIEFING_READ_KEY) !== null);
  const markRead = () => { writeFlag(BRIEFING_READ_KEY, '1'); setRead(true); };
  const ready = !writing && !!tip?.tip && tip.id != null;
  const open = () => { if (ready) { markRead(); discussWithCoach({ kind: 'briefing', id: tip.id! }); } };
  const times = tip && briefingTimes(tip);
  return <div className="space-y-2 font-sans">
    <h2>
      <button type="button" className="briefing-entry flex min-h-11 w-full items-center gap-2 text-left text-sm font-medium text-text-primary"
        disabled={!ready} onClick={open} aria-label="Briefing du jour — ouvrir une nouvelle conversation avec Chiron">
        <Sunrise aria-hidden="true" className="size-4 text-neon-cyan" />
        <span className="flex-1">Briefing du jour</span>
        {ready && <ArrowUpRight aria-hidden="true" className="size-4 text-text-muted" />}
      </button>
    </h2>
    {writing ? <div role="status" className="flex items-center gap-2 text-sm text-text-muted">
      <AretePresence size={24} />Chiron écrit ton briefing…
      {stalled && <Button variant="ghost" className="ml-auto" onClick={refresh}>Actualiser</Button>}
    </div> : !tip?.tip ? <p className="text-xs text-danger-red">Briefing indisponible. <Button variant="ghost" onClick={refresh}>Réessayer</Button></p> : <>
      <p className={`text-sm leading-relaxed text-text-secondary ${ready ? 'line-clamp-3' : ''}`}>{tip.tip}</p>
      {times && <p className="text-[11px] text-text-muted">{times}</p>}
      <div className="flex flex-wrap items-center justify-between gap-1">
        {ready && <Button variant="ghost" size="sm" className="min-h-11 px-0 text-neon-cyan" onClick={open}>En parler avec Chiron <ArrowUpRight aria-hidden="true" className="size-3.5" /></Button>}
        <span className="flex items-center gap-4">
          {/* The briefing quotes ACWR, TSB, VFC…: their meaning is one tap away. */}
          <Link to="/analytics/lexique" className="inline-flex min-h-11 items-center gap-1 text-xs text-text-muted hover:text-text-primary">
            <BookOpen aria-hidden="true" className="size-3.5" />Lexique
          </Link>
          <Button variant="ghost" size="sm" className="min-h-11 px-0" aria-expanded={history} onClick={() => setHistory(!history)}>Briefings précédents <ChevronDown aria-hidden="true" className="size-3.5" /></Button>
        </span>
      </div>
    </>}
    {history && <BriefingHistory onOpen={markRead} />}
    {read && <PushOffer moment="briefing" />}
  </div>;
}
