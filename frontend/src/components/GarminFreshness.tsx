import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchAPI } from '@/lib/api';
import { invalidateAfterGarminRefresh } from '@/lib/queryKeys';

/** One browser-owned refresh on entry/foreground; the server deduplicates tabs. */
export function GarminFreshness() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let active = false;
    async function refresh() {
      if (document.visibilityState === 'hidden' || active) return;
      active = true;
      let state: string | undefined;
      setMessage('Vérification Garmin…');
      try {
        const result = await fetchAPI<{ state: string; complete?: boolean }>('/garmin/sync/ensure', {
          method: 'POST', signal: controller.signal,
        });
        state = result.state;
        if (!disposed) setMessage(['fresh', 'complete', 'disconnected'].includes(result.state)
          ? '' : 'Garmin : synchronisation incomplète. Les données enregistrées restent disponibles.');
      } catch {
        if (!disposed) setMessage('Vérification Garmin indisponible. Les données enregistrées restent disponibles.');
      } finally {
        active = false;
        if (!disposed) {
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
  return message ? <p role="status" className="px-4 py-2 text-xs text-text-secondary">{message}</p> : null;
}
