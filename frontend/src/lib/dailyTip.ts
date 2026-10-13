import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tipsApi } from '@/lib/api';
import { toLocalISODate } from '@/lib/dates';
import { qk } from '@/lib/queryKeys';

/** Reads while the coach writes the day's briefing, then stops and offers a refresh. */
export const TIP_POLL_DELAYS_MS = [5_000, 10_000, 20_000];

/**
 * The day's briefing. A `pending` answer starts its writing in a request of
 * its own (the server runs it once per day, whoever asks) and polls the read.
 * Each day has its own read, so a tab left open overnight polls afresh.
 * `enabled: false` waits for another request to seed the read (the dashboard's,
 * under the server's `day`).
 */
export function useDailyTip({ enabled = true, day: serverDay }: { enabled?: boolean; day?: string } = {}) {
  const client = useQueryClient();
  const day = serverDay ?? toLocalISODate();
  const key = [...qk.tipDaily, day];
  const query = useQuery({
    queryKey: key,
    queryFn: tipsApi.getDaily,
    enabled,
    staleTime: 1000 * 60 * 30,
    refetchInterval: ({ state }) =>
      state.data?.status === 'pending' ? TIP_POLL_DELAYS_MS[state.dataUpdateCount - 1] ?? false : false,
  });
  const { mutate, isPending: posting } = useMutation({
    // Idempotent: the server answers the stored briefing or pending, or writes it.
    mutationFn: (_day: string) => tipsApi.writeDaily(),
    onSuccess: (tip, forDay) => {
      if (tip.status !== 'pending') client.setQueryData([...qk.tipDaily, forDay], tip);
    },
  });
  const pending = query.data?.status === 'pending';
  // Reads so far: on the query's state, which the interval above counts too.
  // `dataUpdatedAt` changes with each read, so it is what re-renders.
  const reads = query.dataUpdatedAt ? client.getQueryState(key)?.dataUpdateCount ?? 0 : 0;
  // One automatic request per pending stretch: a ready read or a new day ends it.
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!pending) {
      if (query.data) askedFor.current = null;
      return;
    }
    if (posting || askedFor.current === day) return;
    askedFor.current = day;
    mutate(day);
  }, [pending, posting, day, query.data, mutate]);
  return {
    tip: query.data && !pending ? query.data : undefined,
    writing: query.isLoading || (!enabled && query.isPending) || pending,
    stalled: pending && reads > TIP_POLL_DELAYS_MS.length,
    refresh: () => {
      if (!posting) mutate(day);
      void query.refetch();
    },
  };
}
