import { describe, expect, it } from 'vitest';
import { formatKm, formatRaceTime, goalCountdown, parseRaceTime } from './race';

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
    const goal = { name: 'Semi de Paris', distance_km: 21.1, days_left: 65 };
    expect(goalCountdown(goal)).toBe('J-65 · Semi de Paris (21,1 km)');
    expect(goalCountdown({ ...goal, days_left: 0 })).toBe('Jour J · Semi de Paris (21,1 km)');
  });

  it('gives a hybrid block no distance', () => {
    const block = { name: 'Bloc hybride', distance_km: 0, days_left: 55, goal_type: 'hybrid' as const };
    expect(goalCountdown(block)).toBe('J-55 · Bloc hybride');
  });
});
