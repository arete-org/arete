import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchAPI } from '@/lib/api';
import { invalidateAfterGarminRefresh } from '@/lib/queryKeys';

/** One browser-owned refresh on entry/foreground; the server deduplicates tabs. */
export function GarminFreshness() {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let active = false;
    async function refresh() {
      if (document.visibilityState === 'hidden' || active) return;
      active = true;
      let state: string | undefined;
      setChecking(true);
      setMessage('');
      try {
        const result = await fetchAPI<{ state: string; complete?: boolean; more_pending?: boolean; errors?: string[] }>('/garmin/sync/ensure', {
          method: 'POST', signal: controller.signal,
        });
        state = result.state;
        // Only the activity cap stopped the refresh: the next one continues, nothing failed.
        const catchingUp = result.state === 'partial' && result.more_pending && !result.errors?.length;
        if (!disposed) setMessage(['fresh', 'complete', 'disconnected'].includes(result.state) ? ''
          : catchingUp ? 'Import Garmin en cours de rattrapage. La suite arrive automatiquement.'
            : 'Garmin : synchronisation incomplète. Les données enregistrées restent disponibles.');
      } catch {
        if (!disposed) setMessage('Vérification Garmin indisponible. Les données enregistrées restent disponibles.');
      } finally {
        active = false;
        if (!disposed) {
          setChecking(false);
          invalidateAfterGarminRefresh(queryClient, state);
        }
      }
    }
    void refresh();
    const foreground = () => { void refresh(); };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      disposed = true;
      controller.abort();
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [queryClient]);
  // The live region exists before it speaks and announces outcomes only; the transient
  // check stays visible without interrupting a screen reader at every page entry.
  return <div>
    {checking && <p className="px-4 py-2 text-xs text-text-secondary">Vérification Garmin…</p>}
    <div role="status">{message && <p className="px-4 py-2 text-xs text-text-secondary">{message}</p>}</div>
  </div>;
}
