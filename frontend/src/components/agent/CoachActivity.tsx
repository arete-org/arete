import { useEffect, useState, useSyncExternalStore } from 'react';
import { CircleAlert, ChevronRight } from 'lucide-react';
import { hasAnswerText, isRecovered, messageTools, toolLabel } from '@/lib/agentActivity';
import { STREAM_TIMEOUT_MS, type ChatMessage } from '@/lib/agentStream';
import { cn } from '@/lib/utils';
import { markWorkout, measureWorkout } from '@/lib/workoutPerformance';
import { ToolActivity } from './ToolActivity';
import { AretePresence } from '../AreteBrand';

const LONG_WAIT_SECONDS = 8;
const CLOCK_TICK_MS = 1_000;

function subscribeConnection(update: () => void) {
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
const ignoreConnection = () => () => {};
const readConnection = () => navigator.onLine;

/** The request timestamp survives hiding the panel or switching threads.
 * The UI clock has the same hard ceiling as the transport deadline. */
function useElapsedSeconds(startedAt: number | undefined, running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current - startedAt >= STREAM_TIMEOUT_MS) window.clearInterval(timer);
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt, running]);
  return startedAt === undefined ? 0 : Math.max(0, Math.min(
    STREAM_TIMEOUT_MS / CLOCK_TICK_MS,
    Math.floor((now - startedAt) / CLOCK_TICK_MS),
  ));
}

/** Decorative motion never announces fake progress or delays streamed text. */
export function CoachPresence({ active = true }: { active?: boolean }) {
  return <AretePresence active={active} />;
}

export function CoachActivity({ message }: { message: ChatMessage }) {
  const pending = message.pending === true;
  const elapsed = useElapsedSeconds(message.startedAt, pending);
  useEffect(() => {
    if (!pending || performance.getEntriesByName('coach:first-feedback', 'mark').length) return;
    markWorkout('coach:first-feedback');
    measureWorkout('coach:time-to-feedback', 'coach:request-start', 'coach:first-feedback');
  }, [message.startedAt, pending]);
  const online = useSyncExternalStore(pending ? subscribeConnection : ignoreConnection, readConnection);

  const tools = messageTools(message);
  const running = tools.find(tool => tool.status === 'running');
  const failed = tools.some(tool => tool.status === 'error' && !isRecovered(tool, tools));
  const uncertain = tools.some(tool => tool.status === 'interrupted');
  const last = tools.at(-1);
  const confirmed = !running && !failed && !uncertain && last?.status === 'done';
  const hasText = hasAnswerText(message);
  const interrupted = message.interrupted || !!message.error;
  const label = interrupted
    ? message.interrupted ? 'Réponse interrompue' : 'Réponse incomplète'
    : pending && message.syncStatus === 'running' ? 'Synchronisation Garmin avant la réponse'
    : running ? toolLabel(running)
      : failed ? 'Une action a échoué'
        : uncertain ? 'Résultat à vérifier'
          : pending && hasText ? 'Réponse en cours'
            : confirmed ? pending ? `${toolLabel(last)} · préparation de la réponse` : toolLabel(last)
              : message.streamAccepted ? 'Chiron prépare sa réponse' : 'Demande envoyée';
  const memoryReceipt = !pending && !interrupted && !failed && !uncertain && message.parts?.some(p => p.kind === 'coach_card' && p.ref_kind === 'fact');
  const statusKey = `${running?.id ?? last?.id ?? 'response'}:${label}`;

  if (!pending && !tools.length && !interrupted) return null;
  return (
    <div className="coach-activity mb-3 min-w-0 space-y-2 text-[13px] leading-relaxed">
      {!memoryReceipt && <p role="status" aria-atomic="true" className={cn('flex min-h-8 items-center gap-2 text-text-secondary', !pending && confirmed && !interrupted && 'text-success-green')}>
        {/* While Chiron thinks, its laurel turns here and the message has no header;
            once text arrives the header shows it, so this line keeps no icon. */}
        {pending && !interrupted ? !hasText && <CoachPresence active={online && !failed && !uncertain && elapsed < STREAM_TIMEOUT_MS / CLOCK_TICK_MS} />
          : confirmed && !interrupted ? <span key={`confirmation:${statusKey}`} className="coach-confirmation" aria-hidden="true" />
            : <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-text-muted" />}
        <span key={`label:${statusKey}`} className="coach-status-label min-w-0">{label}</span>
      </p>}
      {pending && (!online || (!hasText && elapsed >= LONG_WAIT_SECONDS)) && (
        <p role="status" className="max-w-prose text-xs text-text-muted">
          {!online ? 'Connexion perdue. Tu peux arrêter la réponse ; ton brouillon reste conservé.'
            : 'La réponse prend un peu plus de temps. Tu peux continuer à utiliser Arete.'}
        </p>
      )}
      {uncertain && <p className="max-w-prose text-xs text-text-muted">Une action a peut-être déjà été effectuée. Vérifie son résultat avant une nouvelle demande.</p>}
      {message.interrupted && !uncertain && <p className="text-xs text-text-muted">Le texte reçu reste disponible. L’arrêt n’annule pas les actions déjà terminées.</p>}
      <details className="group/activity text-xs">
        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 text-text-muted hover:text-text-secondary [&::-webkit-details-marker]:hidden">
          Voir l’activité <ChevronRight aria-hidden="true" className="size-3 transition-transform group-open/activity:rotate-90 motion-reduce:transition-none" />
        </summary>
        <div className="mt-1 border-l border-text-muted/20 pl-3">
          {pending && <p className="mb-2 font-sans text-[11px] text-text-muted" aria-live="off">En cours depuis {elapsed} s · le temps restant n’est pas estimé.</p>}
          {tools.length ? <ToolActivity tools={tools} compact /> : <p className="text-text-muted">Aucune action reçue.</p>}
        </div>
      </details>
    </div>
  );
}
