import { describe, expect, it } from 'vitest';
import { GLOSSARY_TERMS, glossaryHref, glossaryQuestion, isGlossaryId } from './glossary';
import { GLOSSARY, GLOSSARY_CATEGORIES, searchGlossary } from './glossaryEntries';

// Every component source, to find the terms its "?" links name.
const SOURCES = import.meta.glob(['../**/*.tsx', '!../**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every term a component links to: `term="…"`, `secondaryTerms={[…]}`, `glossaryHref('…')`. */
function linkedTerms(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (term: string, file: string) => found.set(term, [...(found.get(term) ?? []), file]);
  for (const [file, source] of Object.entries(SOURCES)) {
    for (const match of source.matchAll(/\bterm=["']([^"']+)["']/g)) add(match[1], file);
    for (const match of source.matchAll(/glossaryHref\(\s*["']([^"']+)["']\s*\)/g)) add(match[1], file);
    for (const list of source.matchAll(/secondaryTerms=\{\[([^\]]*)\]\}/g))
      for (const match of list[1].matchAll(/["']([^"']+)["']/g)) add(match[1], file);
  }
  return found;
}

describe('glossary entries', () => {
  it('have unique, anchor-safe ids: one entry per term', () => {
    const ids = GLOSSARY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(GLOSSARY_TERMS).sort());
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('are complete and filed under a known category, each category used', () => {
    const categories = new Set(GLOSSARY_CATEGORIES.map((category) => category.id));
    for (const entry of GLOSSARY) {
      expect(categories.has(entry.category), entry.id).toBe(true);
      for (const field of [entry.term, GLOSSARY_TERMS[entry.id], entry.definition, entry.scale, entry.source])
        expect(field.trim(), entry.id).not.toBe('');
      expect(entry.reading.length, entry.id).toBeGreaterThan(0);
    }
    for (const category of categories)
      expect(GLOSSARY.some((entry) => entry.category === category), category).toBe(true);
  });

  it('link to their anchor on the glossary page, with a question as their name', () => {
    expect(glossaryHref('acwr')).toBe('/analytics/lexique#acwr');
    expect(glossaryQuestion('vfc')).toBe('Qu’est-ce que la VFC ?');
    expect(isGlossaryId('toString')).toBe(false);
  });
});

describe('glossary search', () => {
  it('ignores accents and case, and lists everything when empty', () => {
    expect(searchGlossary('').length).toBe(GLOSSARY.length);
    expect(searchGlossary('FRAICHEUR').map((entry) => entry.id)).toContain('tsb');
    expect(searchGlossary('hrv').map((entry) => entry.id)).toEqual(['vfc']);
    expect(searchGlossary('aucun terme pareil')).toEqual([]);
  });
});

describe('info links', () => {
  const linked = linkedTerms();

  it('all target an existing entry', () => {
    const unknown = [...linked].filter(([term]) => !isGlossaryId(term));
    expect(unknown).toEqual([]);
  });

  it('sit next to the main metrics', () => {
    for (const term of ['acwr', 'ctl', 'tsb', 'vfc', 'rpe', 'zones', 'preparation'])
      expect(linked.has(term), term).toBe(true);
  });
});
