// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { documentRequest } from '@/lib/documents';
import { SkillInput } from './SkillInput';

vi.mock('@/lib/documents', () => ({ documentRequest: vi.fn() }));
const skills = [
  { name: 'document-planning', description: 'Lire une prépa jointe.', path: '/skills/system/document-planning/SKILL.md' },
  { name: 'recovery', description: 'Préparer la récupération.', path: '/skills/system/recovery/SKILL.md' },
];
const send = vi.fn();
function Harness() {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return <SkillInput
    inputRef={inputRef}
    aria-label="Message au coach"
    value={value}
    onValueChange={setValue}
    onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) send(value); }}
  />;
}
function setup() {
  render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(documentRequest).mockResolvedValue(skills);
});
afterEach(cleanup);

it('lists skills before sending, selects with arrows and Enter, then sends the explicit command', async () => {
  const input = setup();
  expect(documentRequest).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '/' } });
  await screen.findByRole('listbox', { name: 'Skills disponibles' });
  expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input.value).toBe('/recovery ');
  expect(send).not.toHaveBeenCalled();
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).toHaveBeenCalledWith('/recovery ');
});

it('filters skills and inserts a mouse selection into the existing draft', async () => {
  const input = setup();
  fireEvent.change(input, { target: { value: '/doc Vérifie samedi', selectionStart: 4, selectionEnd: 4 } });
  const option = await screen.findByRole('option', { name: /document-planning/ });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.click(option);
  expect(input.value).toBe('/document-planning Vérifie samedi');
  expect(send).not.toHaveBeenCalled();
});

it('closes only the menu with Escape and permits selecting another leading command', async () => {
  const input = setup();
  fireEvent.change(input, { target: { value: '/' } });
  await screen.findByRole('listbox');
  const escape = vi.fn();
  window.addEventListener('keydown', escape);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(escape).not.toHaveBeenCalled();
  window.removeEventListener('keydown', escape);
  fireEvent.change(input, { target: { value: '/document-planning /rec' } });
  await screen.findByRole('option', { name: /recovery/ });
  fireEvent.keyDown(input, { key: 'Tab' });
  expect(input.value).toBe('/document-planning /recovery ');
  expect(send).not.toHaveBeenCalled();
});

it('does not intercept URLs, ordinary slashes, or IME confirmation', async () => {
  const input = setup();
  fireEvent.change(input, { target: { value: 'Regarde https://example.com/plan' } });
  expect(documentRequest).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '/doc' } });
  await screen.findByRole('listbox');
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(input.value).toBe('/doc');
  expect(send).not.toHaveBeenCalled();
});

it('shows catalog failures, allows retry, and never sends while loading or failed', async () => {
  vi.mocked(documentRequest).mockRejectedValueOnce(new Error('Catalogue indisponible.'));
  const input = setup();
  fireEvent.change(input, { target: { value: '/' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByRole('alert');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  await screen.findByRole('listbox');
  await waitFor(() => expect(documentRequest).toHaveBeenCalledTimes(2));
});

it('shows an empty result without inventing a skill or trapping Tab', async () => {
  const input = setup();
  fireEvent.change(input, { target: { value: '/unknown' } });
  await screen.findByText('Aucun skill correspondant.');
  expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).not.toHaveBeenCalled();
});

it('rejects a long run of slash commands without backtracking exponentially', () => {
  const input = setup();
  const started = performance.now();
  // The former pattern spent several seconds on this draft, growing exponentially with each repeat.
  fireEvent.change(input, { target: { value: `/-${'  /-'.repeat(25)}!` } });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(screen.queryByRole('listbox')).toBeNull();
});
