import type { RunSnapshot } from './coachingRuns';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tipsApi, type DailyTip } from '@/lib/api';
import { toLocalISODate } from '@/lib/dates';
import { qk } from '@/lib/queryKeys';

/** Reads while the coach writes the day's briefing, then stops and offers a refresh. */
export const TIP_POLL_DELAYS_MS = [5_000, 10_000, 20_000];

/**
 * The day's briefing. A `pending` answer starts its writing in a request of
 * its own (the server runs it once per day, whoever asks) and polls the read.
 * Each day has its own read, so a tab left open overnight polls afresh.
 * `enabled: false` waits for another request to seed the read (the dashboard's,
 * under the server's `day`); a seed is not a poll, so seeding again spends none.
 */
export function useDailyTip({ enabled = true, day: serverDay }: { enabled?: boolean; day?: string } = {}) {
  const client = useQueryClient();
  const day = serverDay ?? toLocalISODate();
  const key = [...qk.tipDaily, day];
  // Reads of the day's briefing while it was pending: the polls spent.
  const [spent, setSpent] = useState({ day, polls: 0 });
  const polls = spent.day === day ? spent.polls : 0;
  const observation = useQuery<RunSnapshot>({ queryKey: ['coaching-activity','briefing','current'], enabled: false });
  const query = useQuery({
    queryKey: key,
    queryFn: ({ queryKey }) => {
      const forDay = String(queryKey[1]);
      if (client.getQueryData<DailyTip>(queryKey)?.status === 'pending')
        setSpent((s) => ({ day: forDay, polls: (s.day === forDay ? s.polls : 0) + 1 }));
      return tipsApi.getDaily();
    },
    enabled,
    staleTime: 1000 * 60 * 30,
    refetchInterval: ({ state }) =>
      state.data?.status === 'pending' && observation.data?.state !== 'running' ? TIP_POLL_DELAYS_MS[polls] ?? false : false,
  });
  const { mutate, isPending: posting } = useMutation({
    // Idempotent: the server answers the stored briefing or pending, or writes it.
    mutationFn: (_day: string) => tipsApi.writeDaily(),
    onSuccess: (tip, forDay) => {
      if (tip.status !== 'pending') client.setQueryData([...qk.tipDaily, forDay], tip);
    },
  });
  const pending = query.data?.status === 'pending';
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
    /** The day this briefing's read is keyed by: a reaction updates it there. */
    day,
    tip: query.data && !pending ? query.data : undefined,
    writing: query.isLoading || (!enabled && query.isPending) || pending,
    generating: pending,
    stalled: pending && polls >= TIP_POLL_DELAYS_MS.length,
    refresh: () => {
      if (!posting) mutate(day);
      void query.refetch();
    },
  };
}
