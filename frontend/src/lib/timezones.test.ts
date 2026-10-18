import { afterEach, expect, it, vi } from 'vitest';
import { timezoneGroups } from './timezones';

afterEach(() => vi.restoreAllMocks());

it('offers every zone the browser knows, grouped by region in French', () => {
  const groups = timezoneGroups('Europe/Paris', new Date('2026-01-15T12:00:00Z'));
  const values = groups.flatMap((g) => g.zones.map((z) => z.value));
  expect(new Set(values).size).toBe(values.length);
  expect(values.length).toBeGreaterThan(300);
  expect(groups.map((g) => g.region)).toContain('Asie');
  const europe = groups.find((g) => g.region === 'Europe')!;
  expect(europe.zones.find((z) => z.value === 'Europe/Paris')!.label).toBe('Paris (UTC+1)');
  const america = groups.find((g) => g.region === 'Amérique')!;
  expect(america.zones.find((z) => z.value === 'America/New_York')!.label).toBe('New York (UTC−5)');
});

it('keeps a stored zone the list lacks, and the former choices without Intl support', () => {
  vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => { throw new RangeError('unsupported'); });
  const groups = timezoneGroups('Asia/Kolkata');
  const values = groups.flatMap((g) => g.zones.map((z) => z.value));
  expect(values).toEqual(expect.arrayContaining(['Europe/Paris', 'America/New_York', 'UTC', 'Asia/Kolkata']));
  expect(groups.at(-1)!.region).toBe('Autres');
});

it('lists a renamed zone once, under today\'s name', () => {
  vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Asia/Calcutta', 'Asia/Kolkata', 'Europe/Kiev', 'Europe/Paris']);
  const values = timezoneGroups('Europe/Paris').flatMap((g) => g.zones.map((z) => z.value));
  expect(values.sort()).toEqual(['Asia/Kolkata', 'Europe/Kyiv', 'Europe/Paris']);
});
