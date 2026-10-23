import { describe, expect, it } from 'vitest';
import { parseLocalDate } from './dates';
import {
  blockStart,
  formatKm,
  formatRaceTime,
  goalCountdown,
  hybridEnd,
  hyroxDetails,
  parseRaceTime,
  resizedBlockEnd,
  triDetails,
  triLabel,
} from './race';

describe('race formatting', () => {
  it('writes distances with French decimals and no trailing zeros', () => {
    expect(formatKm(21.1)).toBe('21,1');
    expect(formatKm(42.195)).toBe('42,195');
    expect(formatKm(10)).toBe('10');
  });

  it('writes race times as h:mm:ss, or m:ss under an hour', () => {
    expect(formatRaceTime(5525)).toBe('1:32:05');
    expect(formatRaceTime(2712)).toBe('45:12');
    expect(formatRaceTime(1215)).toBe('20:15');
    expect(formatRaceTime(303)).toBe('5:03');
    expect(formatRaceTime(3600)).toBe('1:00:00');
  });

  it('reads h:mm:ss and mm:ss, rejecting anything else', () => {
    expect(parseRaceTime('1:45:00')).toBe(6300);
    expect(parseRaceTime(' 45:30 ')).toBe(2730);
    expect(parseRaceTime('1:60:00')).toBeNull();
    expect(parseRaceTime('45:75')).toBeNull();
    expect(parseRaceTime('0:00')).toBeNull();
    expect(parseRaceTime('1h45')).toBeNull();
    expect(parseRaceTime('')).toBeNull();
  });

  it('round-trips a formatted time', () => {
    expect(parseRaceTime(formatRaceTime(5525))).toBe(5525);
  });

  it('counts down to the race, then names race day', () => {
    const goal = { name: 'Semi de Paris', distance_km: 21.1, days_left: 65, race_date: '2027-03-07' };
    expect(goalCountdown(goal)).toBe('J-65 · Semi de Paris (21,1 km)');
    expect(goalCountdown({ ...goal, days_left: 0 })).toBe('Jour J · Semi de Paris (21,1 km)');
  });

  it('names a Hyrox by its division and a hybrid block by its end, never a distance', () => {
    const hyrox = { name: 'Hyrox Paris', distance_km: 8, days_left: 90, race_date: '2027-03-20', goal_type: 'hyrox' as const };
    expect(goalCountdown({ ...hyrox, details: null })).toBe('J-90 · Hyrox Paris (Hyrox Open)');
    expect(
      goalCountdown({ ...hyrox, details: { division: 'pro', format: 'doubles', category: 'mixed', equipment: ['none'], weeks: 12 } })
    ).toBe('J-90 · Hyrox Paris (Hyrox Pro · Duo)');
    const block = { name: 'Bloc hiver', distance_km: 0, days_left: 55, race_date: '2027-01-17', goal_type: 'hybrid' as const };
    expect(goalCountdown(block)).toBe('J-55 · Bloc hiver (Bloc hybride · fin le 17 janvier)');
  });
});

describe('hybrid block dates', () => {
  it('ends a block on the Sunday of its last week, starting next Monday', () => {
    // Tuesday 20 October 2026: next Monday is the 26th.
    expect(hybridEnd(8, '2026-10-20')).toBe('2026-12-20');
    expect(hybridEnd(12, '2026-10-20')).toBe('2027-01-17');
    // A Sunday starts the next day; a Monday waits a whole week, as the server does.
    expect(hybridEnd(8, '2026-10-25')).toBe('2026-12-20');
    expect(hybridEnd(8, '2026-10-26')).toBe('2026-12-27');
    expect(parseLocalDate(hybridEnd(12, '2026-10-20')).getDay()).toBe(0);
    expect(blockStart('2027-01-17', 12)).toBe('2026-10-26');
  });

  it('keeps a resized block on its start, within the server window', () => {
    // A 12-week block starting 9 Nov, two weeks out, shortened to 8 weeks.
    expect(resizedBlockEnd('2026-11-09', 8, '2026-10-20')).toBe('2027-01-03');
    // Lengthened back: the same Monday, 12 weeks on.
    expect(resizedBlockEnd('2026-11-09', 12, '2026-10-20')).toBe('2027-01-31');
    // A start the window no longer allows is clamped to its nearest end.
    expect(resizedBlockEnd('2026-10-26', 8, '2026-11-03')).toBe('2027-01-03');
    expect(resizedBlockEnd('2027-01-04', 8, '2026-10-20')).toBe('2027-01-03');
  });
});

describe('triathlon goals', () => {
  const tri = {
    name: 'Triathlon de Paris',
    distance_km: 51.5,
    days_left: 80,
    race_date: '2027-06-06',
    goal_type: 'triathlon' as const,
    details: { distance: 'olympic' as const, hours_per_week: 8, pool_length_m: 25 as const },
  };

  it('names a triathlon by its format, the longest as a distance', () => {
    expect(goalCountdown(tri)).toBe('J-80 · Triathlon de Paris (Triathlon M)');
    expect(triLabel({ distance: 'full' })).toBe('Triathlon distance Ironman');
    expect(triLabel({ distance: 'half' })).toBe('Triathlon 70.3');
    expect(triLabel(null)).toBe('Triathlon');
  });

  it('reads each goal type its own details only', () => {
    expect(triDetails(tri)?.hours_per_week).toBe(8);
    expect(hyroxDetails(tri)).toBeNull();
    const hyrox = { goal_type: 'hyrox' as const, details: { division: 'pro' as const, format: 'solo' as const, category: 'men' as const, equipment: ['none' as const], weeks: 12 as const } };
    expect(hyroxDetails(hyrox)?.division).toBe('pro');
    expect(triDetails(hyrox)).toBeNull();
  });
});
