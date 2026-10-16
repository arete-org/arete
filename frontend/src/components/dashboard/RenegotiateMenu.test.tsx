// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, planApi } from '@/lib/api';
import type { PlannedSession, Renegotiated, RenegotiationMenu } from '@/types';
import { renegotiationOutcome, type Renegotiation } from '@/lib/renegotiation';
import { RenegotiateMenu } from './RenegotiateMenu';
import { RenegotiationOutcome } from './RenegotiationOutcome';

const session: PlannedSession = {
  id: 12, date: '2026-10-14', sport: 'running', session_type: 'tempo', target_duration_min: 50,
  target_distance_km: null, target_hr_zone: 'Z4', target_intensity: 'hard', description: null,
  source: 'manual', status: 'pending', garmin_workout_id: null, garmin_pushed_at: null, revision: 1,
};

const menu: RenegotiationMenu = {
  session_id: 12,
  date: '2026-10-14',
  version: '0123456789abcdef',
  blocked: null,
  reasons: [
    {
      id: 'tired', label: 'Je suis cuit', note: null,
      options: [
        { id: 'lighter', decision: 'ease', label: 'Version allégée', detail: 'Endurance 35 min Z2' },
        { id: 'move', decision: 'move', label: 'Déplacer à jeudi 15 octobre', detail: 'Premier jour libre.' },
      ],
    },
    {
      id: 'no_time', label: 'Pas le temps', note: null,
      options: [{ id: 'shorter', decision: 'ease', label: 'Version courte', detail: 'Tempo 35 min Z4' }],
    },
    {
      id: 'pain', label: 'Douleur / gêne', note: 'Avec une douleur, ni report ni séance plus dure.',
      options: [{ id: 'rest', decision: 'rest', label: 'Repos aujourd’hui', detail: 'La séance est sautée.' }],
    },
  ],
};

const written: Renegotiated = {
  decision: {
    id: 5, date: '2026-10-14', planned_session_id: 12, decision: 'ease',
    reason: 'Je suis cuit : la séance tempo 50 min Z4 devient endurance 35 min Z2.',
    readiness_score: null, readiness_source: 'model', acwr: null, original: null, adapted: null,
    applied_at: '2026-10-14T17:00:00', reverted_at: null, created_at: null,
  },
  date: '2026-10-14',
  garmin: 'sent',
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

function mount(onDone = vi.fn()) {
  render(
    <QueryClientProvider client={client}>
      <RenegotiateMenu session={session} onDone={onDone} />
    </QueryClientProvider>,
  );
  return onDone;
}

it('reads the options only when the menu opens, and focuses the first one', async () => {
  const read = vi.spyOn(planApi, 'renegotiationOptions').mockResolvedValue(menu);
  mount();
  const toggle = screen.getByRole('button', { name: 'Modifier' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  await screen.findByRole('heading', { name: 'Je suis cuit' });
  const group = screen.getByRole('group', { name: 'Modifier la séance du jour' });
  for (const reason of ['Je suis cuit', 'Pas le temps', 'Douleur / gêne']) {
    expect(within(group).getByRole('heading', { name: reason })).toBeTruthy();
  }
  const first = within(group).getByRole('button', { name: /Version allégée/ });
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect(read).toHaveBeenCalledTimes(1);
  expect(within(group).getByText('Avec une douleur, ni report ni séance plus dure.')).toBeTruthy();
});

it('applies the tapped option with the menu’s version, then closes', async () => {
  vi.spyOn(planApi, 'renegotiationOptions').mockResolvedValue(menu);
  const write = vi.spyOn(planApi, 'renegotiate').mockResolvedValue(written);
  const onDone = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  fireEvent.click(await screen.findByRole('button', { name: /Déplacer à jeudi 15 octobre/ }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(write).toHaveBeenCalledWith(12, { reason: 'tired', option: 'move', version: menu.version });
  expect((onDone.mock.calls[0][0] as Renegotiation).option.id).toBe('move');
  expect(screen.queryByRole('group', { name: 'Modifier la séance du jour' })).toBeNull();
});

it('takes one tap at a time', async () => {
  vi.spyOn(planApi, 'renegotiationOptions').mockResolvedValue(menu);
  let finish: (value: Renegotiated) => void = () => {};
  const write = vi.spyOn(planApi, 'renegotiate').mockReturnValue(new Promise((resolve) => (finish = resolve)));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  const lighter = await screen.findByRole('button', { name: /Version allégée/ });
  fireEvent.click(lighter);
  fireEvent.click(lighter);
  fireEvent.click(screen.getByRole('button', { name: /Repos aujourd’hui/ }));
  await waitFor(() => expect(lighter.getAttribute('aria-disabled')).toBe('true'));
  expect(write).toHaveBeenCalledTimes(1);
  // The tapped option keeps the focus while it is sent.
  lighter.focus();
  expect(document.activeElement).toBe(lighter);
  finish(written);
});

it('says a refused choice and reads the options again', async () => {
  const read = vi.spyOn(planApi, 'renegotiationOptions').mockResolvedValue(menu);
  vi.spyOn(planApi, 'renegotiate').mockRejectedValue(
    new ApiError(409, JSON.stringify({ detail: 'Ta séance a changé depuis : recharge les options.' })),
  );
  const onDone = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  fireEvent.click(await screen.findByRole('button', { name: /Version allégée/ }));
  expect((await screen.findByRole('alert')).textContent).toBe('Ta séance a changé depuis : recharge les options.');
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(onDone).not.toHaveBeenCalled();
});

it('explains a blocked session and still opens the coach with it', async () => {
  vi.spyOn(planApi, 'renegotiationOptions').mockResolvedValue({
    ...menu,
    reasons: [],
    blocked: 'Le coach te propose déjà une adaptation de cette séance : réponds-y d’abord.',
  });
  const discussed = vi.fn();
  window.addEventListener('arete:coach-discuss', discussed);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  expect(await screen.findByText(/réponds-y d’abord/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Je suis cuit' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Autre… en parler au coach/ }));
  expect((discussed.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: 'session', id: 12 });
  window.removeEventListener('arete:coach-discuss', discussed);
});

it('closes on Escape and gives the focus back to « Modifier »', async () => {
  vi.spyOn(planApi, 'renegotiationOptions').mockResolvedValue(menu);
  mount();
  const toggle = screen.getByRole('button', { name: 'Modifier' });
  fireEvent.click(toggle);
  const first = await screen.findByRole('button', { name: /Version allégée/ });
  fireEvent.keyDown(first, { key: 'Escape' });
  expect(screen.queryByRole('group')).toBeNull();
  expect(document.activeElement).toBe(toggle);
});

it('reports the written choice apart from Garmin, and takes the focus', () => {
  const lighter = menu.reasons[0].options[0];
  render(
    <RenegotiationOutcome
      outcome={renegotiationOutcome({ result: { ...written, garmin: 'failed' }, option: lighter })}
      onDismiss={() => {}}
    />,
  );
  const status = screen.getByRole('status');
  expect(document.activeElement).toBe(status);
  expect(status.textContent).toContain('Séance modifiée : Endurance 35 min Z2.');
  expect(status.textContent).toContain('Garmin n’a pas confirmé la mise à jour');
  cleanup();
  // Garmin holds no copy: nothing to say, whatever the push setting.
  render(
    <RenegotiationOutcome
      outcome={renegotiationOutcome({
        result: { ...written, date: '2026-10-15', garmin: 'unchanged', decision: { ...written.decision, decision: 'move' } },
        option: menu.reasons[0].options[1],
      })}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Séance déplacée à jeudi 15 octobre.');
});

it('says a copy left by the push off is to remove for a rest, to send again otherwise', () => {
  const rest = menu.reasons[2].options[0];
  render(
    <RenegotiationOutcome
      outcome={renegotiationOutcome({
        result: { ...written, garmin: 'disabled', decision: { ...written.decision, decision: 'rest' } },
        option: rest,
      })}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByRole('status').textContent).toContain('retire-la depuis le Planning');
  cleanup();
  render(
    <RenegotiationOutcome
      outcome={renegotiationOutcome({ result: { ...written, garmin: 'disabled' }, option: menu.reasons[0].options[0] })}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByRole('status').textContent).toContain('renvoie-la depuis le Planning');
});
