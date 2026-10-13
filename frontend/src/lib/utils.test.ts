import { expect, it } from 'vitest';
import { formatPace, parsePace } from './utils';

it("reads paces as m'ss per km and shows them with the same notation", () => {
  expect(parsePace("3'30")).toBe(210);
  expect(parsePace('3’36')).toBe(216);
  expect(parsePace('3:56/km')).toBe(236);
  for (const text of ['', '3', "3'6", "3'60", '210', "0'00"]) expect(parsePace(text)).toBeNull();
  expect(formatPace(210, "'")).toBe("3'30");
  expect(formatPace(210)).toBe('3:30');
});

it('rounds a fractional pace as a whole, never showing 60 seconds', () => {
  expect(formatPace(239.5, "'")).toBe("4'00");
  expect(formatPace(239.4)).toBe('3:59');
});
