// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyticsApi } from '@/lib/api';
import { RpePicker } from './RpePicker';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** One mounted picker whose session changes, as today's card does. */
function mount(sessionId: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (id: number) => <MemoryRouter><QueryClientProvider client={client}><RpePicker sessionId={id} /></QueryClientProvider></MemoryRouter>;
  const view = render(tree(sessionId));
  return (id: number) => view.rerender(tree(id));
}
const picker = () => screen.queryByRole('region', { name: 'Effort ressenti' });

it('shows again for the next session once the previous one was saved', async () => {
  vi.spyOn(analyticsApi, 'updateSession').mockResolvedValue({ success: true } as never);
  const switchTo = mount(4);
  fireEvent.click(screen.getByRole('button', { name: /^6 — / }));
  await waitFor(() => expect(picker()).toBeNull());
  switchTo(5);
  expect(picker()).toBeTruthy();
});

it('a dismissal hides only its own session', () => {
  const switchTo = mount(4);
  fireEvent.click(screen.getByRole('button', { name: 'Ne pas noter cette séance' }));
  expect(picker()).toBeNull();
  switchTo(5);
  expect(picker()).toBeTruthy();
  switchTo(4);
  expect(picker()).toBeNull();
});
