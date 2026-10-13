import { expect, it } from 'vitest';
import { formatPace } from './utils';

it("shows paces as m'ss per km or m:ss", () => {
  expect(formatPace(210, "'")).toBe("3'30");
  expect(formatPace(210)).toBe('3:30');
});

it('rounds a fractional pace as a whole, never showing 60 seconds', () => {
  expect(formatPace(239.5, "'")).toBe("4'00");
  expect(formatPace(239.4)).toBe('3:59');
});
