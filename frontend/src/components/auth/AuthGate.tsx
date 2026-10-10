import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorState } from '@/components/States';
import { authApi, type AuthConfig } from '@/lib/api';
import { AUTH_DISABLED, AuthStateContext } from './authState';
import { GateScreen, GateSpinner } from './GateScreen';

// The Clerk SDK is only fetched when the server asks for sign-in.
const ClerkGate = lazy(() => import('./ClerkGate'));

// Without sign-in the server's require_admin resolves the instance owner.
// Keep the context's unprovided default closed; grant this only after config loads.
const LOCAL_OWNER = { ...AUTH_DISABLED, isAdmin: true, isOwner: true };

type ConfigState =
  | { status: 'loading' }
  /** The server could not be asked: neither on nor off, never let the app pass as if it were off. */
  | { status: 'unknown' }
  | { status: 'ready'; config: AuthConfig };

interface AuthGateProps {
  children: ReactNode;
  /** Runs when a session ends, before the page reloads: drop in-memory caches here. */
  onSessionEnd?: () => void;
}

/**
 * Decides, from `GET /api/auth/config`, whether the app renders as before or
 * behind Clerk's sign-in. Mounted above the query client so the sign-in page
 * needs nothing else.
 */
export function AuthGate({ children, onSessionEnd }: AuthGateProps) {
  const [state, setState] = useState<ConfigState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    authApi.config().then(
      (config) => {
        if (!cancelled) setState({ status: 'ready', config });
      },
      () => {
        if (!cancelled) setState({ status: 'unknown' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  if (state.status === 'loading') return <GateSpinner />;
  if (state.status === 'unknown') {
    return (
      <GateScreen>
        <ErrorState message="SERVEUR INJOIGNABLE" onRetry={retry} />
      </GateScreen>
    );
  }
  const { config } = state;
  if (!config.enabled) {
    return <AuthStateContext.Provider value={LOCAL_OWNER}>{children}</AuthStateContext.Provider>;
  }
  if (!config.publishable_key) {
    return (
      <GateScreen>
        <ErrorState message="AUTHENTIFICATION MAL CONFIGURÉE" onRetry={retry} />
      </GateScreen>
    );
  }
  // A key the SDK rejects would otherwise blank the page: the boundary shows an error instead.
  return (
    <ErrorBoundary>
      <Suspense fallback={<GateSpinner />}>
        <ClerkGate publishableKey={config.publishable_key} onSessionEnd={onSessionEnd}>
          {children}
        </ClerkGate>
      </Suspense>
    </ErrorBoundary>
  );
}
