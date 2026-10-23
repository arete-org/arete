// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { adminApi, KPI_KEYS, type KpiCell, type KpiKey, type KpiWeek } from '@/lib/api';
import { ProductKpisPanel } from './ProductKpisPanel';

/** Text as read, French narrow spaces included. */
const text = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ');

const EMPTY: KpiCell = { numerator: 0, denominator: 0, value: null };

function week(week_start: string, current: boolean, cells: Partial<Record<KpiKey, KpiCell>>): KpiWeek {
  const indicators = Object.fromEntries(KPI_KEYS.map((key) => [key, cells[key] ?? EMPTY])) as Record<KpiKey, KpiCell>;
  return { week_start, current, indicators };
}

const WEEKS: KpiWeek[] = [
  week('2026-10-12', true, {
    active_accounts: { numerator: 1, denominator: 4, value: 0.25 },
    first_action_hours: { numerator: 2, denominator: 3, value: 15.5 },
  }),
  week('2026-10-05', false, {
    active_accounts: { numerator: 3, denominator: 4, value: 0.75 },
    checkins_answered: { numerator: 2, denominator: 4, value: 0.5 },
  }),
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProductKpisPanel />
    </QueryClientProvider>
  );
}

it('shows each week against each indicator, the current one first and on its own', async () => {
  const kpis = vi.spyOn(adminApi, 'kpis').mockResolvedValue(WEEKS);
  mount();

  const table = await screen.findByRole('table');
  expect(kpis).toHaveBeenCalledWith(12);
  const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
  expect(headers).toEqual([
    'Semaine du',
    'Comptes actifs',
    'Abonnés aux notifications',
    'Séances de force saisies',
    'Check-ins répondus',
    'Briefings avec réaction',
    'Contrats du dimanche acceptés',
    'Délai avant la 1re action',
    'Rétention à 30 jours',
    'Réponses au message du soir',
  ]);
  const [current, previous] = within(table).getAllByRole('row').slice(1);
  expect(text(within(current).getByRole('rowheader'))).toBe('12/10/2026 (en cours)');
  const cells = within(previous).getAllByRole('cell');
  expect(text(cells[0])).toBe('75 %3 / 4');
  expect(text(cells[3])).toBe('50 %2 / 4');
  // Nothing counted reads as a dash, not 0 %.
  expect(text(cells[1])).toBe('—0 / 0');
  expect(text(within(current).getAllByRole('cell')[6])).toBe('15,5 h2 sur 3 comptes');

  const tiles = within(screen.getByRole('list', { name: 'Semaine en cours' }));
  expect(text(tiles.getByText('Comptes actifs').parentElement!)).toBe('Comptes actifs25 %1 / 4');
  // The mobile list repeats every week.
  expect(within(screen.getByRole('list', { name: 'Semaines' })).getAllByRole('listitem')).toHaveLength(2);
  // No athlete is named: only the server's counts are shown.
  expect(screen.queryByText(/@/)).toBeNull();
  // The cohorts count sign-ups: every account the migration took over is left out, not the owner's alone.
  expect(
    screen.getByText(/ne comptent que les inscriptions : les comptes repris lors du passage au multi-athlètes/)
  ).toBeTruthy();
});

it('exports the table as CSV, raw values beside their counts', async () => {
  vi.spyOn(adminApi, 'kpis').mockResolvedValue(WEEKS);
  // jsdom has no object URLs: a subclass stands in, and unstubAllGlobals puts URL back.
  const exported: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    exported.push(blob);
    return 'blob:kpis';
  });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    }
  );
  let downloaded = '';
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloaded = this.download;
  });
  mount();

  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /Exporter en CSV/ }));

  expect(click).toHaveBeenCalledOnce();
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(downloaded).toBe('arete-indicateurs-2026-10-12.csv');
  // The byte-order mark lets French Excel read the accents as UTF-8.
  const bytes = new Uint8Array(await exported[0].arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const [header, current, previous] = (await exported[0].text())
    .trimEnd()
    .split('\n')
    .map((line) => line.split(';'));
  expect(header.slice(0, 5)).toEqual([
    'Semaine (lundi)',
    'En cours',
    'Comptes actifs',
    'Comptes actifs - numérateur',
    'Comptes actifs - dénominateur',
  ]);
  expect(header).toHaveLength(2 + 3 * KPI_KEYS.length);
  // Decimals with a comma, as French Excel reads them.
  expect(current.slice(0, 5)).toEqual(['2026-10-12', 'oui', '0,25', '1', '4']);
  expect(current[2 + 3 * KPI_KEYS.indexOf('first_action_hours')]).toBe('15,5');
  // An indicator with nothing counted leaves its value empty.
  expect(previous.slice(5, 8)).toEqual(['', '0', '0']);
});

it('says when the server has no indicator and when it fails', async () => {
  vi.spyOn(adminApi, 'kpis').mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('down'));
  const first = mount();
  expect(await screen.findByText('Aucun indicateur')).toBeTruthy();
  expect((screen.getByRole('button', { name: /Exporter en CSV/ }) as HTMLButtonElement).disabled).toBe(true);
  first.unmount();
  mount();
  expect(await screen.findByText('Indicateurs indisponibles')).toBeTruthy();
});
