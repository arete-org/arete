import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { importChunk } from '@/lib/chunkReload';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorState } from '@/components/States';
import { authApi, type AuthConfig } from '@/lib/api';
import { AUTH_DISABLED, AuthStateContext } from './authState';
import { buildAuthConfig } from './buildConfig';
import { GateScreen, GateSpinner } from './GateScreen';

// The Clerk SDK is only fetched when sign-in is on (main.tsx preloads it when the build says so).
const ClerkGate = lazy(importChunk(() => import('./ClerkGate')));

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
 * Decides whether the app renders as before or behind Clerk's sign-in: from
 * the build when it carries the configuration (no backend round trip before
 * Clerk starts), from `GET /api/auth/config` otherwise. Mounted above the query
 * client so the sign-in page needs nothing else.
 */
export function AuthGate({ children, onSessionEnd }: AuthGateProps) {
  const [built] = useState(buildAuthConfig);
  const [state, setState] = useState<ConfigState>(
    built ? { status: 'ready', config: built } : { status: 'loading' }
  );
  const [attempt, setAttempt] = useState(0);
  const keyMatchesServer = useMemo(
    () => (built ? () => serverExpects(built.publishable_key) : undefined),
    [built]
  );

  useEffect(() => {
    if (built) return;
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
  }, [attempt, built]);

  // Only reached from the server's answer: a build configuration always has its key.
  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  if (state.status === 'loading') return <GateSpinner />;
  if (state.status === 'unknown') {
    return (
      <GateScreen>
        <ErrorState message="Serveur injoignable" onRetry={retry} />
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
        <ErrorState message="Authentification mal configurée" onRetry={retry} />
      </GateScreen>
    );
  }
  // A key the SDK rejects would otherwise blank the page: the boundary shows an error instead.
  return (
    <ErrorBoundary>
      <Suspense fallback={<GateSpinner />}>
        <ClerkGate
          publishableKey={config.publishable_key}
          onSessionEnd={onSessionEnd}
          keyMatchesServer={keyMatchesServer}
        >
          {children}
        </ClerkGate>
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Whether the server verifies sessions of the Clerk instance this build signs
 * into. Asked only after the server refused a session: a build key from another
 * instance is a misconfiguration, not an ended session. Unreachable: assume yes.
 */
function serverExpects(publishableKey: string | null): Promise<boolean> {
  return authApi.config().then(
    (server) => !server.enabled || server.publishable_key === publishableKey,
    () => true
  );
}
