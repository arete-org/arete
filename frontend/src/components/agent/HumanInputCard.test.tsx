// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HumanInputCard } from './HumanInputCard';
import type { HumanInterrupt } from '@/lib/humanInput';

afterEach(cleanup);
const question: HumanInterrupt = {
  id: 'q', revision: 1, expires_at: '2099-01-01T00:00:00Z', decision: null,
  payload: { type: 'question', name: 'ask_athlete', args: { question: 'Comment adapter la séance ?' }, description: '' },
  schema: { type: 'object', properties: { rpe: { type: 'number', title: 'Ressenti', minimum: 0, maximum: 10 }, day: { type: 'string', format: 'date', title: 'Date' }, ready: { type: 'boolean', title: 'Disponible' } }, required: ['rpe','day','ready'], additionalProperties: false },
};
it('submits typed values and preserves them after a corrected server error', async () => {
  const decide = vi.fn().mockRejectedValueOnce(new Error('Révision modifiée')).mockResolvedValue({});
  render(<HumanInputCard item={question} onDecision={decide} />);
  fireEvent.change(screen.getByLabelText('Ressenti'), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-25' } });
  fireEvent.click(screen.getByLabelText('Disponible'));
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer la réponse' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Ressenti') as HTMLInputElement).value).toBe('7');
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer la réponse' }));
  await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  expect(decide).toHaveBeenLastCalledWith({ rpe: 7, day: '2026-10-25', ready: true });
});
it('rejects recursive and unsupported schemas explicitly', () => {
  render(<HumanInputCard item={{ ...question, schema: { $ref: '#/$defs/repeat', $defs: { repeat: { type: 'object', properties: { next: { $ref: '#/$defs/repeat' } } } } } }} onDecision={vi.fn()} />);
  expect(screen.getByRole('alert').textContent).toContain('complexe');
  expect((screen.getByRole('button', { name: 'Envoyer la réponse' }) as HTMLButtonElement).disabled).toBe(true);
});
it('only exposes decisions and editable arguments declared by the server', async () => {
  const decide = vi.fn().mockResolvedValue({});
  const item: HumanInterrupt = { ...question, payload: { name: 'update_planned_session', args: { description: 'Footing' }, description: 'Modifier cette séance' }, schema: { oneOf: [{ type: 'object', properties: { type: { const: 'approve' } }, required: ['type'] }, { type: 'object', properties: { type: { const: 'reject' }, message: { type: 'string' } }, required: ['type','message'] }] } };
  render(<HumanInputCard item={item} onDecision={decide} />);
  expect(screen.queryByRole('button', { name: /^Modifier$/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith({ type: 'approve' }));
});
