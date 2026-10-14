import { expect, it } from 'vitest';
import type { Prescription } from '@/lib/documents';
import { sessionSummary, sessionSummaryParts } from './sessionForm';

const session = (prescription: Prescription | null) => ({
  prescription, target_duration_min: 45, target_distance_km: null, target_hr_zone: 'Z2',
});
const intervals = (skip?: boolean): Prescription => ({ version: 1, steps: [
  { kind: 'warmup', duration_kind: 'seconds', value: 1200, steps: [] },
  { kind: 'repeat', duration_kind: 'lap', repeat: 12, skip_last_recovery: skip, steps: [
    { kind: 'effort', duration_kind: 'meters', value: 400, steps: [] },
    { kind: 'recovery', duration_kind: 'seconds', value: 60, steps: [] },
  ] },
] });

it('summarises targets, a single effort in mm:ss, or the main repeat with its recovery', () => {
  expect(sessionSummary(session(null))).toBe('45 min · Z2');
  expect(sessionSummary(session({ version: 1, steps: [{ kind: 'effort', duration_kind: 'seconds', value: 1200, steps: [] }] }))).toBe('20:00');
  expect(sessionSummary(session(intervals()))).toBe('12 × 400 m · récup. 1:00');
});

it('says a skipped last recovery as the server summary does, outside the recovery amount', () => {
  // services/prescriptions.describe: "12 × (400 m / récupération 1 min), sans la dernière récup".
  expect(sessionSummary(session(intervals(true)))).toBe('12 × 400 m · récup. 1:00, sans la dernière récup');
  expect(sessionSummaryParts(session(intervals(true)))).toEqual({ metric: '12 × 400 m', recovery: '1:00', skipped: true });
  expect(sessionSummaryParts(session(intervals(false))).skipped).toBe(false);
});
