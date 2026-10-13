import { describe, expect, it } from 'vitest';
import { applyEvent, consumeStream, type ChatMessage } from './agentStream';
import { restoreConversation } from './agentConversation';
import type { Prescription, WorkoutStep } from './documents';
import { isWorkoutUpdate, mergeWorkout, prescriptionReady, stepAmount, type WorkoutUpdate } from './workouts';

describe('workout steps', () => {
  it('shows each step amount the same way everywhere', () => {
    const step = (duration_kind: WorkoutStep['duration_kind'], value: number | null): WorkoutStep => ({ kind: 'effort', duration_kind, value, steps: [] });
    expect(stepAmount(step('seconds', 1200))).toBe('20:00');
    expect(stepAmount(step('seconds', 60))).toBe('1:00');
    expect(stepAmount(step('meters', 400))).toBe('400 m');
    expect(stepAmount(step('reps', 8))).toBe('8 répétitions');
    expect(stepAmount(step('lap', null))).toBe('tour manuel');
    expect(stepAmount(step('seconds', null))).toBe('—');
  });

  it('is ready to save only with every value and both bounds of every target', () => {
    const effort: WorkoutStep = { kind: 'effort', duration_kind: 'seconds', value: 60, steps: [] };
    const repeat = (child: WorkoutStep): Prescription => ({ version: 1, steps: [{ kind: 'repeat', duration_kind: 'lap', repeat: 2, steps: [child] }] });
    expect(prescriptionReady(repeat(effort))).toBe(true);
    expect(prescriptionReady(repeat({ ...effort, value: null }))).toBe(false);
    expect(prescriptionReady(repeat({ ...effort, target: { kind: 'pace_sec_km', low: 210, high: null } }))).toBe(false);
    expect(prescriptionReady(repeat({ ...effort, duration_kind: 'lap', value: null }))).toBe(true);
    // What the server would refuse is not saved either.
    expect(prescriptionReady(repeat({ ...effort, target: { kind: 'heart_rate_bpm', low: 160, high: 150 } }))).toBe(false);
    expect(prescriptionReady(repeat({ ...effort, target: { kind: 'pace_sec_km', low: 210, high: 210 } }))).toBe(true);
  });
});

const update: WorkoutUpdate = {
  type: 'workout_update', id: 'call', thread_id: 'thread', sequence: 100,
  session: { id: 4, revision: 1, date: '2027-01-12', sport: 'running', description: 'Fractionné', status: 'pending', summary: '6 × 400 m' },
  export: { session_id: 4, operation_id: 'op', updated_at: '2027-01-10T12:00:00', state: 'working', phase: 'creating', error: null, deleted: false, workout_id: null, schedule_id: null },
};
describe('workout event contract', () => {
  it('preserves cards through browser storage and rejects stale events', () => {
    const message: ChatMessage = { role: 'assistant', content: '', pending: true };
    const next = applyEvent(message, update);
    expect(next.workouts).toHaveLength(1);
    expect(applyEvent(next, { ...update, sequence: 99, session: { ...update.session, description: 'Old' } })).toEqual(next);
    const restored = restoreConversation(JSON.stringify([next]));
    expect(restored[0].workouts).toEqual([update]);
    expect(restored[0].pending).toBe(false);
    expect(restored[0].interrupted).toBe(true);
  });
  it('does not let a stale query overwrite a newer revision or operation', () => {
    const latest = { ...update, session: { ...update.session, revision: 2 }, export: { ...update.export!, state: 'scheduled', updated_at: '2027-01-10T12:01:00' } };
    expect(mergeWorkout(latest, update)).toEqual(latest);
    expect(mergeWorkout(latest, { ...update, session: latest.session }).export?.state).toBe('scheduled');
  });
  it('rejects corrupt events and saved cards explicitly', () => {
    expect(isWorkoutUpdate({ ...update, session: { ...update.session, id: -1 } })).toBe(false);
    expect(isWorkoutUpdate({ ...update, export: { ...update.export, session_id: 9 } })).toBe(false);
    expect(() => restoreConversation(JSON.stringify([{ role: 'assistant', content: '', workouts: [{}] }]))).toThrow('Séances sauvegardées invalides');
  });
  it('delivers a card from fragmented SSE before the final response exists', async () => {
    const encoder = new TextEncoder();
    const seen: string[] = [];
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const body = new ReadableStream<Uint8Array>({ async start(controller) {
      const event = `data: ${JSON.stringify(update)}\n\n`;
      controller.enqueue(encoder.encode(event.slice(0, 17)));
      controller.enqueue(encoder.encode(event.slice(17)));
      await barrier;
      controller.enqueue(encoder.encode('data: {"type":"done","message":{"role":"assistant","content":"Programmé"}}\n\n'));
    } });
    const consuming = consumeStream(body, event => { seen.push(event.type); if (event.type === 'workout_update') { expect(seen).toEqual(['workout_update']); finish(); } });
    await consuming;
    expect(seen).toEqual(['workout_update', 'done']);
  });
});
