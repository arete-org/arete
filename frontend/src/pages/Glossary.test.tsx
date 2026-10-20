// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GlossaryLink } from '@/components/GlossaryLink';
import { GLOSSARY } from '@/lib/glossaryEntries';
import { GlossaryPage } from './Glossary';

const scrolled: string[] = [];
beforeEach(() => {
  scrolled.length = 0;
  // jsdom has no layout: record which element was brought into view.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this.id);
  });
});
afterEach(cleanup);

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/analytics/lexique" element={<GlossaryPage />} />
        <Route path="/" element={<GlossaryLink term="acwr" />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('renders every entry under its anchor', () => {
  mount('/analytics/lexique');
  expect(screen.getByRole('heading', { level: 1, name: 'Lexique' })).toBeTruthy();
  for (const entry of GLOSSARY) {
    const article = document.getElementById(entry.id);
    expect(article?.tagName, entry.id).toBe('ARTICLE');
    expect(within(article!).getByRole('heading', { level: 3, name: entry.term })).toBeTruthy();
  }
  expect(scrolled).toEqual([]);
});

it('lands on the anchored entry: scrolled into view, focused and marked', () => {
  mount('/analytics/lexique#vfc');
  expect(scrolled).toEqual(['vfc']);
  expect(document.activeElement?.id).toBe('vfc-term');
  expect(document.getElementById('vfc')?.dataset.current).toBe('true');
  expect(document.getElementById('acwr')?.dataset.current).toBeUndefined();
});

it('opens the entry from a metric’s "?"', () => {
  mount('/');
  const link = screen.getByRole('link', { name: 'Qu’est-ce que le ratio charge aiguë / chronique (ACWR) ?' });
  expect(link.getAttribute('href')).toBe('/analytics/lexique#acwr');
  fireEvent.click(link);
  expect(screen.getByRole('heading', { level: 1, name: 'Lexique' })).toBeTruthy();
  expect(scrolled).toEqual(['acwr']);
  expect(document.activeElement?.id).toBe('acwr-term');
});

it('filters entries by a search, accents ignored', () => {
  mount('/analytics/lexique');
  const search = screen.getByLabelText('Rechercher un terme');
  fireEvent.change(search, { target: { value: 'variabilite' } });
  expect(document.getElementById('vfc')).not.toBeNull();
  expect(document.getElementById('acwr')).toBeNull();
  expect(screen.getByText(/termes? trouvés?/)).toBeTruthy();
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(screen.getByText('Aucun terme ne correspond à « zzz ».')).toBeTruthy();
});
