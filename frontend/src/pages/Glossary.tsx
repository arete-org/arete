import { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui';
import {
  GLOSSARY_CATEGORIES,
  TONE_LABEL,
  searchGlossary,
  type GlossaryEntry,
  type GlossaryTone,
} from '@/lib/glossaryEntries';
import { isGlossaryId } from '@/lib/glossary';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<GlossaryTone, string> = {
  good: 'text-success-green',
  neutral: 'text-text-secondary',
  caution: 'text-warning-orange',
  bad: 'text-danger-red',
};

function Entry({ entry, current }: { entry: GlossaryEntry; current: boolean }) {
  const others = entry.aliases.filter((alias) => alias !== entry.term);
  return (
    <article
      id={entry.id}
      aria-labelledby={`${entry.id}-term`}
      data-current={current || undefined}
      className="glossary-entry analysis-card"
    >
      <header>
        <h3 id={`${entry.id}-term`} tabIndex={-1} className="text-[15px] font-medium text-text-primary">
          {entry.term}
        </h3>
        {others.length > 0 && (
          <p className="mt-1 text-xs text-text-muted">Aussi affiché : {others.join(' · ')}</p>
        )}
      </header>
      <p className="text-sm leading-relaxed text-text-secondary">{entry.definition}</p>
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-xs text-text-muted">Échelle</dt>
          <dd className="text-text-primary">{entry.scale}</dd>
        </div>
        {entry.range && (
          <div>
            <dt className="text-xs text-text-muted">Valeurs habituelles</dt>
            <dd className="text-text-primary">{entry.range}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-text-muted">Comment le lire</dt>
          <dd>
            <ul className="mt-1 space-y-1.5">
              {entry.reading.map((band) => (
                <li key={band.text} className="flex gap-2">
                  <span className={cn('w-16 shrink-0 text-xs font-medium leading-5', TONE_CLASS[band.tone])}>
                    {TONE_LABEL[band.tone]}
                  </span>
                  <span className="text-text-primary">{band.text}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Source</dt>
          <dd className="text-text-secondary">{entry.source}</dd>
        </div>
      </dl>
    </article>
  );
}

/** « Lexique »: every term and metric of the app, anchored per term (`#acwr`). */
export function GlossaryPage() {
  const { hash } = useLocation();
  // Only a known term is a target: a hand-typed or malformed hash is ignored.
  const raw = hash.slice(1);
  const target = isGlossaryId(raw) ? raw : '';
  const [query, setQuery] = useState('');
  const searchId = useId();
  const entries = searchGlossary(query);

  // A "?" lands here with the term's anchor: bring it into view and give it the focus.
  useEffect(() => {
    if (!target) return;
    const entry = document.getElementById(target);
    if (!entry) return;
    entry.scrollIntoView({ block: 'start' });
    document.getElementById(`${target}-term`)?.focus({ preventScroll: true });
  }, [target]);

  return (
    <div className="page-shell bg-void">
      <div className="page-content mx-auto max-w-3xl space-y-8">
        <header>
          <Link
            to="/analytics"
            className="-ml-1 inline-flex min-h-11 items-center gap-1 text-sm font-sans text-text-muted hover:text-text-primary"
          >
            <ArrowLeft className="size-4" aria-hidden /> Analyses
          </Link>
          <p className="page-eyebrow">Arete / Lexique</p>
          <h1 className="page-title">Lexique</h1>
          <p className="mt-1 text-sm text-text-muted">
            Les termes et les mesures d’Arete et de son coach : ce qu’ils veulent dire, leur échelle et les seuils que
            l’application applique.
          </p>
        </header>

        <div>
          <label htmlFor={searchId} className="mb-1 block text-xs text-text-muted">
            Rechercher un terme
          </label>
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ACWR, fraîcheur, VFC…"
            className="min-h-11 text-base sm:text-sm"
          />
          <p aria-live="polite" className="mt-1 text-xs text-text-muted">
            {query.trim() ? `${entries.length} terme${entries.length > 1 ? 's' : ''} trouvé${entries.length > 1 ? 's' : ''}` : ''}
          </p>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-text-muted">Aucun terme ne correspond à « {query.trim()} ».</p>
        ) : (
          GLOSSARY_CATEGORIES.map((category) => {
            const inCategory = entries.filter((entry) => entry.category === category.id);
            if (inCategory.length === 0) return null;
            return (
              <section key={category.id} aria-labelledby={`lexique-${category.id}`} className="space-y-4">
                <h2 id={`lexique-${category.id}`} className="text-[22px] font-medium text-text-primary">
                  {category.title}
                </h2>
                {inCategory.map((entry) => (
                  <Entry key={entry.id} entry={entry} current={entry.id === target} />
                ))}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
