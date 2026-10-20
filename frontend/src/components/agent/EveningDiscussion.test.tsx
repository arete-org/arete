// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { coachApi, type EveningMessage } from '@/lib/coachToday';
import { EveningDiscussion } from './EveningDiscussion';

const message: EveningMessage = { id: 7, date: '2026-10-16', for_date: '2026-10-17', reasons: ['session'], text: 'Demain, 50 min de tempo. Comment sont tes jambes ?', question: 'Comment sont tes jambes ?', written_at: '2026-10-16T18:05:00+00:00', answer: null, answered_at: null, answerable: true, journaled: false };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><EveningDiscussion id={7} /></QueryClientProvider>);
}
it('shows the message and its question as context, and how to answer', async () => {
  vi.spyOn(coachApi, 'evening').mockResolvedValue(message);
  mount();
  expect(await screen.findByText('Comment sont tes jambes ?')).toBeTruthy();
  expect(screen.getByText('Demain, 50 min de tempo.')).toBeTruthy();
  expect(screen.getByRole('heading').textContent).toContain('samedi 17 octobre');
  expect(screen.getByRole('status').textContent).toContain('Réponds dans le champ ci-dessous');
  expect(screen.queryByRole('textbox')).toBeNull(); // the shared composer answers
});
it('says where an answer went once it is kept', async () => {
  vi.spyOn(coachApi, 'evening').mockResolvedValue({ ...message, answer: 'Lourdes.', answered_at: '2026-10-16T18:40:00+00:00', answerable: false, journaled: true });
  mount();
  await screen.findByText('Comment sont tes jambes ?');
  expect(screen.getByRole('status').textContent).toContain('notée dans le journal de Coach : « Lourdes. »');
});
it('is honest about an answer not filed yet and a closed question', async () => {
  const read = vi.spyOn(coachApi, 'evening').mockResolvedValue({ ...message, answer: 'Lourdes.', answered_at: '2026-10-16T18:40:00+00:00', answerable: false, journaled: false });
  const first = mount();
  await screen.findByText('Comment sont tes jambes ?');
  expect(screen.getByRole('status').textContent).toContain('pas encore dans le journal de Coach');
  first.unmount();
  read.mockResolvedValue({ ...message, answerable: false });
  mount();
  await screen.findByText('Comment sont tes jambes ?');
  expect(screen.getByRole('status').textContent).toBe('Cette question est close : écris à Coach si tu veux en parler.');
});
