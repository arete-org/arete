import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it } from 'vitest';
import { afterCheckin, type CheckinSaved } from './checkins';
import { qk } from './queryKeys';

const DAY = '2026-10-15';
const saved: CheckinSaved = {
  date: DAY, sleep: 2, legs: 4, mood: null, note: null,
  answered_at: `${DAY}T05:12:00+00:00`, updated_at: `${DAY}T05:12:00+00:00`, replanned: false,
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => client.clear());

it('a dashboard read started before the answer cannot bring the card back', async () => {
  client.setQueryData(qk.dashboard(DAY), { date: DAY, checkin: null });
  // A refresh in flight, read before the answer was saved: it still says unanswered.
  const stale = client
    .fetchQuery({
      queryKey: qk.dashboard(DAY),
      queryFn: () => new Promise((resolve) => setTimeout(() => resolve({ date: DAY, checkin: null }), 20)),
    })
    .catch(() => undefined);
  await afterCheckin(client, saved);
  await stale;
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(client.getQueryData(qk.dashboard(DAY))).toMatchObject({ checkin: { sleep: 2, legs: 4 } });
});
