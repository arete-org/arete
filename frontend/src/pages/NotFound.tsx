import { Link, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';

/** Any address the app does not know: a French page and a way home, not a blank screen. */
export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="page-shell bg-void">
      <div className="page-content">
        <section aria-labelledby="not-found-title" className="glass-panel mx-auto max-w-lg space-y-4 p-6 text-center font-sans">
          <Compass aria-hidden="true" className="mx-auto size-8 text-neon-cyan" />
          <h1 id="not-found-title" className="page-title">Page introuvable</h1>
          <p className="text-sm text-text-secondary">
            L’adresse <span className="break-all text-text-primary">{pathname}</span> ne correspond à aucune page d’Arete.
            Le lien est peut-être ancien ou incomplet.
          </p>
          <Link
            to="/"
            className="ui-button inline-flex min-h-11 items-center justify-center rounded border border-neon-cyan/30 bg-neon-cyan/10 px-4 text-sm text-neon-cyan hover:bg-neon-cyan/20"
          >
            Retour à l’accueil
          </Link>
        </section>
      </div>
    </div>
  );
}
