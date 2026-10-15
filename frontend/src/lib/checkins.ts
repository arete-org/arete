import type { QueryClient } from '@tanstack/react-query';
import { fetchAPI } from './api';
import { coachTodayKey } from './coachToday';
import type { DashboardData } from './dashboard';
import { readFlag, writeFlag } from './install';
import { qk } from './queryKeys';

/** The morning check-in (`/checkins`): 1 is always the worst, 5 the best. */
export interface Checkin {
  date: string;
  sleep: number;
  legs: number;
  /** « Motivation / stress », optional. */
  mood: number | null;
  note: string | null;
  answered_at: string;
  updated_at: string;
}
export interface CheckinAnswer { sleep: number; legs: number; mood?: number | null; note?: string | null }
/** `replanned`: a low answer after the day's run asked its decision again (a proposal to validate). */
export interface CheckinSaved extends Checkin { replanned: boolean }

export const MAX_CHECKIN_NOTE = 280;

export const checkinApi = {
  save: (day: string, answer: CheckinAnswer) =>
    fetchAPI<CheckinSaved>(`/checkins/${day}`, { method: 'PUT', body: JSON.stringify(answer) }),
};

/**
 * The answer is the dashboard's `checkin` slice: written into it, the card
 * hides without a read. A new proposal (`replanned`) refreshes the dashboard
 * and the coach card, which carry it.
 */
export function afterCheckin(client: QueryClient, saved: CheckinSaved): void {
  const { replanned, ...checkin } = saved;
  client.setQueriesData<DashboardData>({ queryKey: qk.dashboard() }, (board) =>
    board && board.date === checkin.date ? { ...board, checkin } : board,
  );
  if (!replanned) return;
  void client.invalidateQueries({ queryKey: qk.dashboard() });
  void client.invalidateQueries({ queryKey: coachTodayKey });
}

const DISMISSED_KEY = 'arete.checkin.dismissed';

/** "Plus tard" holds for the day it was said on, on this device. */
export const checkinDismissed = (day: string) => readFlag(DISMISSED_KEY) === day;
export const dismissCheckin = (day: string) => writeFlag(DISMISSED_KEY, day);
