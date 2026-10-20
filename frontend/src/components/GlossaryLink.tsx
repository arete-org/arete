import { CircleHelp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { glossaryHref, glossaryQuestion, type GlossaryId } from '@/lib/glossary';
import { cn } from '@/lib/utils';

/**
 * A "?" beside a metric, opening its glossary entry. The icon stays small
 * next to a label; its touch target is 44 px without moving the layout. No
 * `title`: a tooltip never shows on a phone, the entry says it all.
 */
export function GlossaryLink({ term, className }: { term: GlossaryId; className?: string }) {
  const label = glossaryQuestion(term);
  return (
    <Link
      to={glossaryHref(term)}
      aria-label={label}
      className={cn(
        "relative inline-flex size-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-neon-cyan after:absolute after:-inset-3 after:content-[''] motion-reduce:transition-none",
        className,
      )}
    >
      <CircleHelp aria-hidden className="size-3.5" />
    </Link>
  );
}
