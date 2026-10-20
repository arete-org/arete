import { Link } from 'react-router-dom';
import { ClipboardCheck } from 'lucide-react';
import { preloadRoute } from '@/pages/routes';

/**
 * The dashboard's way into « Ma semaine »: shown while the week's review
 * waits for an answer. Its data is a field of `GET /dashboard`, no request
 * of its own.
 */
export function WeekReviewEntry({ open }: { open: number }) {
  return (
    <Link
      to="/planning/semaine"
      onPointerEnter={() => preloadRoute('/planning/semaine')}
      onFocus={() => preloadRoute('/planning/semaine')}
      className="glass-panel flex min-h-11 items-center gap-3 px-4 py-3 text-left hover:border-neon-purple/50"
    >
      <ClipboardCheck className="size-5 shrink-0 text-neon-purple" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-sans font-semibold text-text-primary">Ta semaine est prête</span>
        <span className="block text-xs font-sans text-text-muted">
          {open > 0
            ? `Bilan de ta semaine · ${open} proposition${open > 1 ? 's' : ''} du coach à accepter`
            : 'Bilan de ta semaine · semaine suivante à accepter'}
        </span>
      </span>
      <span aria-hidden className="text-neon-cyan">→</span>
    </Link>
  );
}
