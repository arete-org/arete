import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tipsApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/** Reads while the coach writes the day's briefing, then stops and offers a refresh. */
export const TIP_POLL_DELAYS_MS = [5_000, 10_000, 20_000];

/**
 * The day's briefing. A `pending` answer starts its writing in a request of
 * its own (the server runs it once per day, whoever asks) and polls the read.
 */
export function useDailyTip() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: qk.tipDaily,
    queryFn: tipsApi.getDaily,
    staleTime: 1000 * 60 * 30,
    refetchInterval: ({ state }) =>
      state.data?.status === 'pending' ? TIP_POLL_DELAYS_MS[state.dataUpdateCount - 1] ?? false : false,
  });
  const { mutate: write, isIdle, isError } = useMutation({
    mutationFn: tipsApi.writeDaily,
    onSuccess: tip => {
      if (tip.status !== 'pending') client.setQueryData(qk.tipDaily, tip);
    },
  });
  const pending = query.data?.status === 'pending';
  // Reads so far: on the query's state, which the interval above counts too.
  // `dataUpdatedAt` changes with each read, so it is what re-renders.
  const reads = query.dataUpdatedAt ? client.getQueryState(qk.tipDaily)?.dataUpdateCount ?? 0 : 0;
  useEffect(() => {
    if (pending && isIdle) write();
  }, [pending, isIdle, write]);
  return {
    tip: query.data && !pending ? query.data : undefined,
    writing: query.isLoading || pending,
    stalled: pending && reads > TIP_POLL_DELAYS_MS.length,
    refresh: () => {
      if (isError) write();
      void query.refetch();
    },
  };
}
