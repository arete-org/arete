import { CircleHelp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { glossaryHref, glossaryQuestion, type GlossaryId } from '@/lib/glossary';

/**
 * A "?" beside a metric, opening its glossary entry. The icon stays small
 * next to a label; its touch target is 44 px without moving the layout. No
 * `title`: a tooltip never shows on a phone, the entry says it all. `about`
 * tells apart two links to the same term on one page.
 */
export function GlossaryLink({ term, about }: { term: GlossaryId; about?: string }) {
  const label = glossaryQuestion(term, about);
  return (
    <Link
      to={glossaryHref(term)}
      aria-label={label}
      className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-neon-cyan after:absolute after:-inset-3 after:content-[''] motion-reduce:transition-none"
    >
      <CircleHelp aria-hidden className="size-3.5" />
    </Link>
  );
}
