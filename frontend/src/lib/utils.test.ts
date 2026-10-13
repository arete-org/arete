import { expect, it } from 'vitest';
import { formatClock, formatPace, parseClock, parsePace } from './utils';

it('reads step durations as mm:ss, h:mm:ss or bare minutes', () => {
  expect(parseClock('20:00')).toBe(1200);
  expect(parseClock('20')).toBe(1200);
  expect(parseClock('1:30')).toBe(90);
  expect(parseClock(' 1:05:00 ')).toBe(3900);
  for (const text of ['', '1:', '1:5', '1:60', '1:60:00', '0', '0:00', '1,5', '20 min', 'abc']) expect(parseClock(text)).toBeNull();
});

it('shows step durations as mm:ss and from an hour as h:mm:ss', () => {
  expect(formatClock(1200)).toBe('20:00');
  expect(formatClock(60)).toBe('1:00');
  expect(formatClock(90)).toBe('1:30');
  expect(formatClock(3900)).toBe('1:05:00');
});

it("reads paces as m'ss per km and shows them with the same notation", () => {
  expect(parsePace("3'30")).toBe(210);
  expect(parsePace('3’36')).toBe(216);
  expect(parsePace('3:56/km')).toBe(236);
  for (const text of ['', '3', "3'6", "3'60", '210', "0'00"]) expect(parsePace(text)).toBeNull();
  expect(formatPace(210, "'")).toBe("3'30");
  expect(formatPace(210)).toBe('3:30');
});
