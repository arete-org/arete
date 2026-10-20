// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, Link, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OPENED_IN_JOURNAL, useEntryClose } from './entryClose';

/** The Journal's contract: `new=1` opens the entry, which the Journal can open itself. */
function Journal() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const close = useEntryClose(() => setParams({}, { replace: true }));
  return (
    <>
      <h1>Journal</h1>
      <button type="button" onClick={() => navigate('/log?new=1', { replace: true, state: OPENED_IN_JOURNAL })}>Saisir</button>
      {params.get('new') === '1' && <button type="button" onClick={close}>Fermer</button>}
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<><h1>Accueil</h1><Link to="/log?new=1">Saisir une séance</Link><Link to="/log">Journal</Link><Link to="/planning">Planning</Link></>} />
        <Route path="/planning" element={<><h1>Planning</h1><Link to="/log?new=1">Saisir</Link></>} />
        <Route path="/log" element={<Journal />} />
      </Routes>
    </BrowserRouter>
  );
}

/** Opens the tab at `url` as its first page, as a link from outside the app does. */
function openTab(url: string) {
  window.history.replaceState(null, '', url);
  render(<App />);
}

beforeEach(() => openTab('/'));
afterEach(cleanup);

it('returns to Home when Home opened the entry', async () => {
  fireEvent.click(screen.getByRole('link', { name: 'Saisir une séance' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(await screen.findByRole('heading', { name: 'Accueil' })).toBeTruthy();
  expect(window.location.pathname + window.location.search).toBe('/');
});

it('returns to whichever page opened it', async () => {
  cleanup();
  openTab('/planning');
  fireEvent.click(screen.getByRole('link', { name: 'Saisir' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
});

it('falls back to Home without an in-app page before it', async () => {
  cleanup();
  openTab('/log?new=1');
  const before = window.history.length;
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(await screen.findByRole('heading', { name: 'Accueil' })).toBeTruthy();
  expect(window.location.pathname + window.location.search).toBe('/');
  // Replaced, not pushed: back does not reopen the entry.
  expect(window.history.length).toBe(before);
});

it('closes in place when the Journal opened it, though a page precedes the Journal', () => {
  fireEvent.click(screen.getByRole('link', { name: 'Journal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Saisir' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(screen.getByRole('heading', { name: 'Journal' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Fermer' })).toBeNull();
  expect(window.location.pathname + window.location.search).toBe('/log');
});

it('goes back one page only, however many times it is closed', async () => {
  fireEvent.click(screen.getByRole('link', { name: 'Planning' }));
  fireEvent.click(screen.getByRole('link', { name: 'Saisir' }));
  const go = vi.spyOn(window.history, 'go');
  const close = screen.getByRole('button', { name: 'Fermer' });
  // A double tap lands before the first navigation does.
  fireEvent.click(close);
  fireEvent.click(close);
  expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
  expect(go).toHaveBeenCalledOnce();
  go.mockRestore();
});
