// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { goalsApi, metricsApi } from '@/lib/api';
import { GoalsTab } from './GoalsTab';
import { DEFAULT_SETTINGS } from './types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderTab(settings = DEFAULT_SETTINGS) {
  vi.spyOn(goalsApi, 'list').mockResolvedValue([]);
  vi.spyOn(metricsApi, 'getPaces').mockResolvedValue({ paces: null, reason: 'Pas de VDOT.' } as never);
  const updateSetting = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GoalsTab settings={settings} updateSetting={updateSetting} />
    </QueryClientProvider>
  );
  return { updateSetting, client };
}

it('sets the FTP within 50 to 600 W and clears it otherwise', () => {
  const { updateSetting, client } = renderTab();
  const ftp = screen.getByPlaceholderText('230');
  fireEvent.change(ftp, { target: { value: '245' } });
  expect(updateSetting).toHaveBeenLastCalledWith('ftp_w', 245);
  fireEvent.change(ftp, { target: { value: '900' } });
  expect(updateSetting).toHaveBeenLastCalledWith('ftp_w', null);
  client.clear();
});

it('reads the CSS as m:ss per 100 m, between 1:00 and 5:00', () => {
  const { updateSetting, client } = renderTab({ ...DEFAULT_SETTINGS, css_sec_100m: 98 });
  const css = screen.getByPlaceholderText('1:45') as HTMLInputElement;
  expect(css.value).toBe('1:38');
  fireEvent.blur(css, { target: { value: '1:52' } });
  expect(updateSetting).toHaveBeenLastCalledWith('css_sec_100m', 112);
  // A running pace typed here is no swim pace: refused, not stored.
  fireEvent.blur(css, { target: { value: '5:30' } });
  expect(updateSetting).toHaveBeenLastCalledWith('css_sec_100m', null);
  client.clear();
});
