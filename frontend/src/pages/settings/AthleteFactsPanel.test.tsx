// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { athleteFactsApi } from '@/lib/api';
import type { AthleteFact } from '@/types';
import { AthleteFactsPanel, FactList } from './AthleteFactsPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fact = (id: number, over: Partial<AthleteFact> = {}): AthleteFact => ({
  id,
  kind: 'injury',
  text: `Fait ${id}`,
  since: '2026-09-01',
  status: 'active',
  source: 'coach',
  evidence: 'legacy',
  revision: 1,
  source_ref: '',
  valid_until: null,
  updated_at: '2026-09-01T08:00:00',
  ...over,
});

const facts = [
  fact(1, { status: 'resolved', kind: 'preference', source: 'athlete' }),
  fact(2, { kind: 'constraint' }),
];

function renderList(over: Partial<Parameters<typeof FactList>[0]> = {}) {
  const actions = { onSave: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(), onConfirm: vi.fn() };
  render(<FactList facts={facts} busyId={null} {...actions} {...over} />);
  return actions;
}

it('lists active facts first and dims resolved ones', () => {
  renderList();
  const rows = screen.getAllByRole('listitem');
  expect(rows.map((r) => r.dataset.status)).toEqual(['active', 'resolved']);
  expect(rows[0].className).not.toContain('opacity-50');
  expect(rows[1].className).toContain('opacity-50');
  expect(within(rows[0]).getByText('Contrainte')).toBeTruthy();
  expect(within(rows[0]).getByText('coach')).toBeTruthy();
  expect(within(rows[1]).getByText('Préférence')).toBeTruthy();
  expect(within(rows[1]).getByText('toi')).toBeTruthy();
});

it('resolves an active fact and reactivates a resolved one', () => {
  const { onToggle, onDelete } = renderList();
  fireEvent.click(screen.getByRole('button', { name: 'Résolu' }));
  expect(onToggle).toHaveBeenLastCalledWith(facts[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Réactiver' }));
  expect(onToggle).toHaveBeenLastCalledWith(facts[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Supprimer le fait' })[0]);
  expect(onDelete).toHaveBeenCalledWith(facts[1]);
});

it('edits a fact in place and only saves a changed text', () => {
  const { onSave } = renderList();
  const row = screen.getAllByRole('listitem')[0];
  fireEvent.click(within(row).getByRole('button', { name: /Corriger/ }));
  fireEvent.click(within(row).getByRole('button', { name: 'Enregistrer le fait' }));
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(within(row).getByRole('button', { name: /Corriger/ }));
  fireEvent.change(within(row).getByLabelText('Texte du fait'), { target: { value: '  Pas de côtes  ' } });
  fireEvent.click(within(row).getByRole('button', { name: 'Enregistrer le fait' }));
  expect(onSave).toHaveBeenCalledWith(facts[1], 'Pas de côtes');
  expect(within(row).getByText('Fait 2')).toBeTruthy();
});

it('writes changes at once, without the settings save button', async () => {
  vi.spyOn(athleteFactsApi, 'list').mockResolvedValue(facts);
  const update = vi.spyOn(athleteFactsApi, 'update').mockResolvedValue({ ...facts[1], status: 'resolved' });
  const create = vi.spyOn(athleteFactsApi, 'create').mockResolvedValue(fact(3));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AthleteFactsPanel />
    </QueryClientProvider>
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Résolu' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(2, { status: 'resolved', expected_revision: 1 }));
  fireEvent.change(screen.getByLabelText('Type de fait'), { target: { value: 'goal' } });
  fireEvent.change(screen.getByLabelText('Nouveau fait'), { target: { value: 'Sub 1h45 au semi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ kind: 'goal', text: 'Sub 1h45 au semi' }));
  client.clear();
});

it('confirms a hypothesis with the revision that was displayed', async () => {
  const hypothesis = fact(4, { evidence: 'hypothesis', revision: 3 });
  vi.spyOn(athleteFactsApi, 'list').mockResolvedValue([hypothesis]);
  const update = vi.spyOn(athleteFactsApi, 'update').mockResolvedValue({ ...hypothesis, evidence: 'explicit', revision: 4 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AthleteFactsPanel /></QueryClientProvider>);
  expect(await screen.findByText('hypothèse à confirmer')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(4, { evidence: 'explicit', expected_revision: 3 }));
  client.clear();
});

it('shows a conflict and refreshes instead of retrying a stale write', async () => {
  vi.spyOn(athleteFactsApi, 'list').mockResolvedValue([fact(5, { revision: 2 })]);
  const update = vi.spyOn(athleteFactsApi, 'update').mockRejectedValue(new Error('Ce fait a changé. Recharge-le.'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AthleteFactsPanel /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Résolu' }));
  expect(await screen.findByText('Ce fait a changé. Recharge-le.')).toBeTruthy();
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(5, { status: 'resolved', expected_revision: 2 });
  client.clear();
});

it('loads history only when opened and sends an expiry for a temporary fact', async () => {
  vi.spyOn(athleteFactsApi, 'list').mockResolvedValue([fact(6)]);
  const history = vi.spyOn(athleteFactsApi, 'history').mockResolvedValue([fact(6)]);
  const create = vi.spyOn(athleteFactsApi, 'create').mockResolvedValue(fact(7));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AthleteFactsPanel /></QueryClientProvider>);
  await screen.findByText('Fait 6');
  expect(history).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Historique' }));
  expect(await screen.findByRole('list', { name: 'Historique du fait' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Nouveau fait'), { target: { value: 'Disponible mercredi exceptionnellement' } });
  fireEvent.change(screen.getByLabelText('Fin de validité'), { target: { value: '2026-10-14' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ kind: 'injury', text: 'Disponible mercredi exceptionnellement', valid_until: '2026-10-14' }));
  client.clear();
});

it('keeps the original edit revision when a background refresh changes the row', () => {
  const original = fact(9, { revision: 1 });
  const actions = { onSave: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(), onConfirm: vi.fn() };
  const view = render(<FactList facts={[original]} busyId={null} {...actions} />);
  fireEvent.click(screen.getByRole('button', { name: /Corriger/ }));
  fireEvent.change(screen.getByLabelText('Texte du fait'), { target: { value: 'Mon brouillon ancien' } });
  view.rerender(<FactList facts={[{ ...original, revision: 2, text: 'Correction dans un autre onglet' }]} busyId={null} {...actions} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le fait' }));
  expect(actions.onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 9, revision: 1 }), 'Mon brouillon ancien');
});
