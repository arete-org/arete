import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, WifiOff, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { connectivity, subscribeConnectivity, type Connectivity } from '@/lib/connectivity';
import { focusNear } from '@/lib/focus';
import { onReloadHold, reloadsHeld, takeWaitingAtLoad } from '@/lib/chunkReload';
import { activate, watchForUpdate } from '@/lib/serviceWorker';

const RELOAD_WAIT_MS = 10_000;

function Notice({ icon, label, children, actions, onDismiss, dismissLabel }: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  actions?: ReactNode;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div ref={root} role="status" aria-label={label} className="app-notice glass-panel flex items-center gap-3 px-3 py-2 font-sans text-sm animate-fade-down">
      <span aria-hidden="true" className="shrink-0">{icon}</span>
      <p className="min-w-0 flex-1 text-text-primary">{children}</p>
      {actions}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={() => { if (root.current) focusNear(root.current); onDismiss(); }}
        className="flex size-11 shrink-0 items-center justify-center rounded text-text-muted hover:bg-text-muted/15 hover:text-text-primary"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/** Lost network, or a server that stopped answering: the page may show older data. */
function ConnectivityNotice() {
  const queryClient = useQueryClient();
  const status = useSyncExternalStore(subscribeConnectivity, connectivity, () => 'online' as Connectivity);
  // A dismissal holds for this outage only: the next one shows again.
  const [dismissed, setDismissed] = useState<Connectivity | null>(null);
  useEffect(() => {
    const reset = () => setDismissed(null);
    // The event itself ends the outage, even when the network drops again before it is handled.
    window.addEventListener('online', reset);
    const stop = subscribeConnectivity(() => { if (connectivity() === 'online') reset(); });
    return () => { window.removeEventListener('online', reset); stop(); };
  }, []);
  if (status === 'online' || dismissed === status) return null;
  const offline = status === 'offline';
  return (
    <Notice
      icon={<WifiOff className="size-4 text-warning-orange" />}
      label="Connexion"
      dismissLabel="Masquer l’alerte de connexion"
      onDismiss={() => setDismissed(status)}
      actions={!offline && (
        <Button size="sm" variant="ghost" className="min-h-11 shrink-0" onClick={() => void queryClient.refetchQueries({ type: 'active' })}>
          Réessayer
        </Button>
      )}
    >
      {offline
        ? 'Hors connexion : les données affichées peuvent dater, et rien ne sera envoyé avant le retour du réseau.'
        : 'Serveur injoignable : les données affichées peuvent dater.'}
    </Notice>
  );
}

/**
 * A new version installed while the page was open waits for the athlete's
 * « Recharger »; one already waiting when the page loaded is taken at once.
 */
function UpdateNotice() {
  const [worker, setWorker] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);
  // A streaming coach answer would be cut: « Recharger » waits for its end.
  const held = useSyncExternalStore(onReloadHold, reloadsHeld, () => false);
  useEffect(() => watchForUpdate((waiting, atLoad) => {
    if (atLoad && takeWaitingAtLoad(waiting)) return;
    setWorker(waiting);
  }), []);
  useEffect(() => {
    if (!worker) return;
    // Replaced by an even newer version: that one is announced in turn.
    const gone = () => { if (worker.state === 'redundant') setWorker(null); };
    worker.addEventListener('statechange', gone);
    return () => worker.removeEventListener('statechange', gone);
  }, [worker]);
  if (!worker || dismissed) return null;
  const reload = async () => {
    setReloading(true);
    await activate(worker, RELOAD_WAIT_MS);
    window.location.reload();
  };
  return (
    <Notice
      icon={<RefreshCw className="size-4 text-neon-cyan" />}
      label="Mise à jour"
      dismissLabel="Masquer l’annonce de mise à jour"
      onDismiss={() => setDismissed(true)}
      actions={
        <Button size="sm" className="min-h-11 shrink-0" loading={reloading} disabled={held} onClick={() => void reload()}>
          Recharger
        </Button>
      }
    >
      {held ? 'Nouvelle version disponible : recharge une fois la réponse de Chiron terminée.' : 'Nouvelle version disponible.'}
    </Notice>
  );
}

/** The app-wide notices, above every page: connectivity first, then a waiting version. */
export function AppNotices() {
  return (
    <div className="app-notices">
      <ConnectivityNotice />
      <UpdateNotice />
    </div>
  );
}
