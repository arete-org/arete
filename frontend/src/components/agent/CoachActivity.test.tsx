// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyEvent, settleMessage, STREAM_TIMEOUT_MS, type ChatMessage } from '@/lib/agentStream';
import { CoachActivity } from './CoachActivity';

let message: ChatMessage;
const preview = { text: '{}', truncated: false };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
  message = { role: 'assistant', content: '', pending: true, startedAt: Date.now() };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('acknowledges immediately, waits for transport acceptance and keeps the timer behind details', () => {
  const { rerender } = render(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Demande envoyée');
  expect(screen.getByText('Voir l’activité').closest('details')?.open).toBe(false);
  act(() => vi.advanceTimersByTime(9_000));
  // A timer must never manufacture server acceptance or successful actions.
  expect(screen.getAllByRole('status')[0].textContent).toBe('Demande envoyée');
  expect(screen.getByText(/un peu plus de temps/)).toBeTruthy();
  rerender(<CoachActivity message={{ ...message, streamAccepted: true }} />);
  expect(screen.getByText('Chiron prépare sa réponse')).toBeTruthy();
  expect(screen.getByText(/En cours depuis 9 s/).getAttribute('aria-live')).toBe('off');
});

it('reports the actual tool, distinguishes reads from writes and confirms only tool_end', () => {
  message = applyEvent(message, { type: 'tool_start', id: 'read', name: 'read_file', args: preview });
  const { rerender } = render(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Lecture d’un fichier');
  message = applyEvent(message, { type: 'tool_end', id: 'read', name: 'read_file', status: 'done', output: preview, elapsed_ms: 15 });
  rerender(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Fichier consulté · préparation de la réponse');
  message = applyEvent(message, { type: 'tool_start', id: 'edit', name: 'edit_file', args: preview });
  rerender(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Mise à jour de tes notes');
  message = applyEvent(message, { type: 'tool_end', id: 'edit', name: 'edit_file', status: 'done', output: preview, elapsed_ms: 15 });
  rerender(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Notes mises à jour · préparation de la réponse');
});

it('does not let one completed parallel action conceal another pending or failed action', () => {
  for (const id of ['one', 'two']) message = applyEvent(message, { type: 'tool_start', id, name: 'read_file', args: preview });
  message = applyEvent(message, { type: 'tool_end', id: 'two', name: 'read_file', status: 'done', output: preview, elapsed_ms: 5 });
  const { rerender } = render(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Lecture d’un fichier');
  message = applyEvent(message, { type: 'tool_end', id: 'one', name: 'read_file', status: 'error', output: preview, elapsed_ms: 5 });
  rerender(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Une action a échoué');
});

it('reports the final outcome once the coach repeats a failed call after fixing its cause', () => {
  const update = { text: '{"session_id":112,"revision":3,"changes":{"status":"skipped"}}', truncated: false };
  const failure = { text: '{"error":"Réconcilie l’export Garmin avant de modifier la séance."}', truncated: false };
  const call = (id: string, name: string, args: typeof preview, status: 'done' | 'error', output = preview) => {
    message = applyEvent(message, { type: 'tool_start', id, name, args });
    message = applyEvent(message, { type: 'tool_end', id, name, status, output, elapsed_ms: 5 });
  };
  call('skip', 'update_planned_session', update, 'error', failure);
  call('check', 'reconcile_garmin_session', { text: '{"session_id":112}', truncated: false }, 'done');
  const { rerender } = render(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Une action a échoué');
  call('retry', 'update_planned_session', update, 'done');
  rerender(<CoachActivity message={settleMessage({ ...message, content: 'Séances mises à jour.' })} />);
  expect(screen.getByRole('status').textContent).toBe('Séance mise à jour');
  expect(screen.getByText('Échec · repris')).toBeTruthy();
  expect(screen.queryByText('Activité · erreur')).toBeNull();
});

it('never treats a parallel duplicate or a different call as a recovery', () => {
  for (const id of ['one', 'two']) message = applyEvent(message, { type: 'tool_start', id, name: 'reconcile_garmin_session', args: preview });
  message = applyEvent(message, { type: 'tool_end', id: 'one', name: 'reconcile_garmin_session', status: 'error', output: preview, elapsed_ms: 5 });
  message = applyEvent(message, { type: 'tool_end', id: 'two', name: 'reconcile_garmin_session', status: 'done', output: preview, elapsed_ms: 5 });
  message = applyEvent(message, { type: 'tool_start', id: 'list', name: 'list_planned', args: preview });
  message = applyEvent(message, { type: 'tool_end', id: 'list', name: 'list_planned', status: 'done', output: preview, elapsed_ms: 5 });
  render(<CoachActivity message={settleMessage(message)} />);
  expect(screen.getByRole('status').textContent).toBe('Une action a échoué');
  expect(screen.getByText('Échec')).toBeTruthy();
});

it('keeps an interrupted action uncertain and does not claim it was rolled back', () => {
  message = applyEvent(message, { type: 'tool_start', id: 'edit', name: 'edit_file', args: preview });
  render(<CoachActivity message={settleMessage(message, undefined, true)} />);
  expect(screen.getByRole('status').textContent).toBe('Réponse interrompue');
  expect(screen.getByText(/Une action a peut-être déjà été effectuée/)).toBeTruthy();
  expect(screen.queryByText('Notes mises à jour')).toBeNull();
});

it('recovers elapsed time after remount and stops its clock at the transport bound', () => {
  vi.advanceTimersByTime(11_000);
  render(<CoachActivity message={message} />);
  expect(screen.getByText(/En cours depuis 11 s/)).toBeTruthy();
  act(() => vi.advanceTimersByTime(STREAM_TIMEOUT_MS));
  expect(screen.getByText(/En cours depuis 310 s/)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

it('uses an offline notice without retrying or hiding the received text state', () => {
  const connection = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  render(<CoachActivity message={message} />);
  act(() => { connection.mockReturnValue(false); window.dispatchEvent(new Event('offline')); });
  expect(screen.getByText(/Connexion perdue/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Réessayer/ })).toBeNull();
});

it('detects a connection lost between requests before the next offline event', () => {
  const connection = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  const { rerender } = render(<CoachActivity message={{ ...message, pending: false }} />);
  connection.mockReturnValue(false);
  rerender(<CoachActivity message={message} />);
  expect(screen.getByText(/Connexion perdue/)).toBeTruthy();
});


it('keeps waiting after tool completion, stops motion on the first text and never delays tokens', () => {
  message = applyEvent(message, { type: 'tool_start', id: 'read', name: 'read_file', args: preview });
  message = applyEvent(message, { type: 'tool_end', id: 'read', name: 'read_file', status: 'done', output: preview, elapsed_ms: 15 });
  const { container, rerender } = render(<CoachActivity message={message} />);
  expect(container.querySelector('.activity-orbit')).not.toBeNull();
  expect(container.querySelector('.coach-confirmation')).toBeNull();
  message = applyEvent(message, { type: 'token', id: 'answer', text: 'Voici' });
  rerender(<CoachActivity message={message} />);
  expect(screen.getByRole('status').textContent).toBe('Réponse en cours');
  expect(container.querySelector('.activity-orbit')).toBeNull();
  rerender(<CoachActivity message={settleMessage(message)} />);
  expect(screen.getByRole('status').textContent).toBe('Fichier consulté');
  expect(container.querySelector('.coach-confirmation')).not.toBeNull();
});

it('stops the orbit when offline, cancelled or past the transport deadline', () => {
  const connection = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  const { container, rerender } = render(<CoachActivity message={message} />);
  expect(container.querySelector('.activity-orbit')).not.toBeNull();
  act(() => { connection.mockReturnValue(false); window.dispatchEvent(new Event('offline')); });
  expect(container.querySelector('.activity-orbit')).toBeNull();
  act(() => { connection.mockReturnValue(true); window.dispatchEvent(new Event('online')); });
  expect(container.querySelector('.activity-orbit')).not.toBeNull();
  act(() => vi.advanceTimersByTime(STREAM_TIMEOUT_MS));
  expect(container.querySelector('.activity-orbit')).toBeNull();
  rerender(<CoachActivity message={settleMessage(message, undefined, true)} />);
  expect(container.querySelector('.activity-orbit')).toBeNull();
});

it('turns the laurel while Chiron thinks and drops it once the answer is written', () => {
  message = applyEvent(message, { type: 'tool_start', id: 'read', name: 'read_file', args: preview });
  message = applyEvent(message, { type: 'tool_end', id: 'read', name: 'read_file', status: 'done', output: preview, elapsed_ms: 15 });
  const { rerender } = render(<CoachActivity message={message} />);
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('Fichier consulté · préparation de la réponse');
  expect(status.querySelector('.activity-orbit')).toBeTruthy();
  expect(status.querySelector('.activity-presence .arete-mark')).toBeTruthy();
  // The message header shows the laurel from the first word on: never twice.
  rerender(<CoachActivity message={applyEvent(message, { type: 'token', id: 'answer', text: 'Repos.' })} />);
  expect(screen.getAllByRole('status')[0].querySelector('.arete-mark')).toBeNull();
});

it('lets the inline receipt own a completed memory confirmation while retaining the audit', () => {
  message = applyEvent(message, { type: 'tool_start', id: 'fact', name: 'remember_fact', args: preview });
  message = applyEvent(message, { type: 'tool_end', id: 'fact', name: 'remember_fact', status: 'done', output: preview, elapsed_ms: 10 });
  message = applyEvent(message, { type: 'coach_card', id: 'fact:1', ref_kind: 'fact', ref_id: 1 });
  render(<CoachActivity message={settleMessage({ ...message, content: 'D’accord.' })} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('Voir l’activité')).toBeTruthy();
});
