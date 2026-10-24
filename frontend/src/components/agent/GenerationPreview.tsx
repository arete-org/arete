import { Button } from '@/components/ui';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { observeGeneration, snapshotMessage } from '@/lib/coachingRuns';
import type { ChatMessage } from '@/lib/agentStream';
import { readableError } from '@/lib/utils';
import { RunActivity } from './RunActivity';

/** Mount only in an open view. Observation never starts a generation. */
type Props = { kind: string; sourceId?: string; activeOnly?: boolean };
export function GenerationPreview(props: Props) {
  // A new source has independent presentation state, even when React reuses the page.
  return <GenerationObservation key={`${props.kind}:${props.sourceId ?? 'current'}`} {...props} />;
}
function GenerationObservation({ kind, sourceId = 'current', activeOnly = false }: Props) {
  const [message, setMessage] = useState<ChatMessage | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const queryClient = useQueryClient();
  useEffect(() => {
    const controller = new AbortController();
    let seenRunning = false;
    void observeGeneration(kind, sourceId, current => {
      if (controller.signal.aborted) return;
      setError('');
      seenRunning ||= current.state === 'running';
      // 'current' may still point at yesterday's completed generation while
      // today's owner is preparing. Refresh its domain result, but do not show it
      // as the new provisional answer.
      if (sourceId !== 'current' || seenRunning) setMessage(snapshotMessage(current));
      queryClient.setQueryData(['coaching-activity', kind, sourceId], current);
      if (current.state !== 'running') void queryClient.invalidateQueries({ predicate: query => ['tip-daily','postSession','automation-run','inbox','review','session-detail','evening'].some(key => String(query.queryKey[0]).includes(key)) });
    }, controller.signal).catch(err => { if (!controller.signal.aborted) { queryClient.removeQueries({ queryKey: ['coaching-activity', kind, sourceId], exact: true }); setError(readableError(err)); } });
    return () => controller.abort();
  }, [kind, sourceId, queryClient, attempt]);
  return <GenerationPreviewView message={message} error={error} activeOnly={activeOnly} onRetry={() => { setError(''); setAttempt(n => n + 1); }} />;
}

/** Shared presentation also used by the local gallery without opening a subscription. */
export function GenerationPreviewView({ message, error = '', activeOnly = false, onRetry }: {
  message: ChatMessage | null; error?: string; activeOnly?: boolean; onRetry: () => void;
}) {
  if ((!message && !error) || (activeOnly && message && message.runState !== 'running')) return null;
  return <section aria-label="Génération en cours" className="space-y-2 rounded-xl border border-border p-3">
    {message && <><RunActivity message={message} /><p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{message.content}</p>{message.pending && <p className="text-xs text-text-muted">Texte provisoire · pas encore enregistré</p>}</>}
    {error && <p role="alert" className="text-xs text-danger-red">Suivi indisponible : {error} <Button variant="ghost" onClick={onRetry}>Actualiser le suivi</Button></p>}
  </section>;
}
