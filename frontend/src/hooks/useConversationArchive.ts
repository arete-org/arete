import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { archivePayload, conversationsApi, digest } from '@/lib/conversations';
import { updateThread, type ThreadStore } from '@/lib/agentThreads';
import { readableError } from '@/lib/utils';

const ARCHIVE_DELAY_MS = 1_000;
export const conversationsKey = ['coach-conversations'];

export function useConversationArchive(store: ThreadStore, setStore: Dispatch<SetStateAction<ThreadStore>>, enabled: boolean) {
  const latest = useRef(store);
  const busy = useRef(false);
  const failed = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const client = useQueryClient();
  useEffect(() => {
    latest.current = store;
    const present = new Set(store.threads.map(t => t.id));
    for (const id of failed.current.keys()) if (!present.has(id)) failed.current.delete(id);
  }, [store]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      if (busy.current) return;
      busy.current = true;
      void (async () => {
        // The local cache has a named bound. Serialize writes, including imports,
        // so a slow response never overwrites the revision of a newer snapshot.
        for (const original of latest.current.threads) {
          if (!mounted.current) break;
          const thread = latest.current.threads.find(t => t.id === original.id);
          if (!thread || (!thread.messages.length && !thread.reference) || thread.messages.some(m => m.pending)) continue;
          const hash = await digest(archivePayload(thread));
          if (hash === thread.archiveDigest || failed.current.get(thread.id) === hash) continue;
          try {
            const saved = await conversationsApi.save(thread, hash);
            if (!mounted.current) break;
            setStore(current => updateThread(current, thread.id, t => ({ ...t, archiveRevision: saved.revision, archiveDigest: hash, title: t.titleManual ? t.title : saved.title })));
            void client.invalidateQueries({ queryKey: conversationsKey });
          } catch (err) {
            failed.current.set(thread.id, hash);
            if (mounted.current) setError(`Non sauvegardée : ${readableError(err)} La copie locale est conservée.`);
          }
        }
      })().catch(err => { if (mounted.current) setError(`Sauvegarde indisponible : ${readableError(err)}`); }).finally(() => {
        busy.current = false;
        // Store changes during the HTTP request must get another bounded pass.
        if (mounted.current && latest.current !== store) setTick(t => t + 1);
      });
    }, ARCHIVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [store, setStore, enabled, tick, client]);
  const retry = useCallback(() => { failed.current.clear(); setError(''); setTick(t => t + 1); }, []);
  return { error, retry };
}
