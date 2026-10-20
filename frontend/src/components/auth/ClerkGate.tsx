import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClerkProvider, SignIn, UserButton, useAuth, useUser } from '@clerk/react';
import { frFR } from '@clerk/localizations/fr-FR';
import { ErrorState } from '@/components/States';
import { AreteWordmark } from '@/components/AreteBrand';
import { ApiError, authApi, type AuthMe, type ConsentState } from '@/lib/api';
import { clearApiCache, clearSignedOutCaches, endSession, onConsentRequired, onUnauthorized, setTokenGetter } from '@/lib/auth';
import { AuthStateContext, type AuthState } from './authState';
import { ConsentScreen } from './ConsentScreen';
import { GateScreen, GateSpinner } from './GateScreen';
import { SignOutButton } from './SignOutButton';
import { claimPushDevice } from '@/lib/pushSession';

// Clerk's widgets read the app's CSS tokens (index.css), so they follow the active theme.
const appearance = {
  variables: {
    colorPrimary: 'var(--color-neon-cyan)',
    colorPrimaryForeground: 'var(--color-on-accent)',
    colorBackground: 'var(--color-abyss)',
    colorForeground: 'var(--color-text-primary)',
    colorMutedForeground: 'var(--color-text-secondary)',
    colorMuted: 'var(--color-shadow)',
    colorNeutral: 'var(--color-text-primary)',
    colorInput: 'var(--color-void)',
    colorInputForeground: 'var(--color-text-primary)',
    colorBorder: 'var(--color-border)',
    colorDanger: 'var(--color-danger-red)',
    colorSuccess: 'var(--color-success-green)',
    colorWarning: 'var(--color-warning-orange)',
    fontFamily: 'var(--font-sans)',
    borderRadius: 'var(--radius-control)',
  },
};

interface ClerkGateProps {
  publishableKey: string;
  /** Runs when a session ends, before the page reloads. */
  onSessionEnd?: () => void;
  /**
   * With a build-time key only: resolves false when the server expects another
   * Clerk instance, so its 401 shows a misconfiguration instead of signing out
   * into the same refusal again.
   */
  keyMatchesServer?: () => Promise<boolean>;
  children: ReactNode;
}

/**
 * Everything that needs the Clerk SDK: the provider, the sign-in page, the
 * account check and the account menu. AuthGate loads this module lazily, only
 * when the server requires sign-in, so the SDK stays out of the main bundle.
 */
export default function ClerkGate({ publishableKey, onSessionEnd, keyMatchesServer, children }: ClerkGateProps) {
  return (
    <ClerkProvider publishableKey={publishableKey} localization={frFR} appearance={appearance}>
      <SessionGate onSessionEnd={onSessionEnd} keyMatchesServer={keyMatchesServer}>
        {children}
      </SessionGate>
    </ClerkProvider>
  );
}

/** Clerk's account menu, for the desktop bar. */
export function AccountButton() {
  return <UserButton />;
}

type Account =
  | { status: 'error' }
  /** The server answered 403: its word on this account (deactivated…), which a retry cannot change. */
  | { status: 'refused'; detail: string | null }
  | { status: 'ready'; me: AuthMe };

function SessionGate({ onSessionEnd, keyMatchesServer, children }: Omit<ClerkGateProps, 'publishableKey'>) {
  const { isLoaded, isSignedIn, sessionId, getToken, signOut } = useAuth();
  const { user } = useUser();
  const [attempt, setAttempt] = useState(0);
  // The account answer belongs to the session and attempt it was asked for; any other is still loading.
  const key = `${sessionId ?? ''}#${attempt}`;
  const [account, setAccount] = useState<{ key: string; value: Account } | null>(null);
  const [leaving, setLeaving] = useState<'no' | 'yes' | 'failed' | 'misconfigured'>('no');
  const leavingRef = useRef(false);

  // Clerk's getToken may change identity; the registry gets one function that reads the latest.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const leave = useCallback(
    () => endSession((then) => signOut(then), onSessionEnd),
    [signOut, onSessionEnd]
  );

  // Signed out: nothing of a previous account may survive in the API or query caches.
  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      void clearSignedOutCaches();
      void claimPushDevice(null).catch((error: unknown) => console.error(error));
    }
  }, [isLoaded, isSignedIn]);

  // Signed in: every request carries the session token, then the account is looked up.
  useEffect(() => {
    if (!isSignedIn) return;
    setTokenGetter(() => getTokenRef.current());
    let cancelled = false;
    clearApiCache().then(() => {
      onSessionEnd?.();
      return authApi.me();
    }).then(
      async (me) => {
        if (cancelled) return;
        await claimPushDevice(me.athlete_id);
        if (!cancelled) setAccount({ key, value: { status: 'ready', me } });
      },
      (error: unknown) => {
        // A 401 is already in the hands of the unauthorized hook below.
        if (!cancelled && !(error instanceof ApiError && error.status === 401)) {
          setAccount({
            key,
            value:
              error instanceof ApiError && error.status === 403
                ? { status: 'refused', detail: error.detail }
                : { status: 'error' },
          });
        }
      }
    ).catch(() => {
      if (!cancelled) setAccount({ key, value: { status: 'error' } });
    });
    return () => {
      cancelled = true;
      setTokenGetter(null);
    };
  }, [isSignedIn, key, onSessionEnd]);

  // The server refused the session: end it, so Clerk shows the sign-in page again.
  useEffect(
    () =>
      onUnauthorized(() => {
        if (leavingRef.current) return;
        leavingRef.current = true;
        setLeaving('yes');
        (keyMatchesServer?.() ?? Promise.resolve(true))
          .then((matches) => (matches ? leave() : setLeaving('misconfigured')))
          .catch(() => setLeaving('failed'));
      }),
    [leave, keyMatchesServer]
  );

  const grantGoogleScopes = useCallback(
    async (scopes: string[], returnTo: string) => {
      if (!user) throw new Error('Session absente : reconnecte-toi.');
      const google = user.externalAccounts.find((a) => a.provider === 'google');
      const pending = google
        ? await google.reauthorize({ additionalScopes: scopes, redirectUrl: returnTo })
        : await user.createExternalAccount({
            strategy: 'oauth_google',
            additionalScopes: scopes,
            redirectUrl: returnTo,
          });
      const consent = pending.verification?.externalVerificationRedirectURL;
      if (!consent) return false;
      window.location.assign(consent.href);
      return true;
    },
    [user]
  );

  // A consent or a withdrawal answers with the new state: the gate follows it without asking again.
  const setConsent = useCallback(
    (consent: ConsentState) =>
      setAccount((previous) =>
        previous?.value.status === 'ready'
          ? { key: previous.key, value: { status: 'ready', me: { ...previous.value.me, consent } } }
          : previous
      ),
    []
  );

  const current = account?.key === key ? account.value : null;
  const me = current?.status === 'ready' ? current.me : null;
  const consentMissing = me !== null && me.consent.required && !me.consent.current;

  // Mid-session, the server refused a request for missing consent (a new text version, a withdrawal
  // on another device): ask the account again, once at a time, and let the gate follow its answer.
  const refreshing = useRef(false);
  useEffect(
    () =>
      onConsentRequired(() => {
        if (refreshing.current) return;
        refreshing.current = true;
        authApi
          .me()
          .then((fresh) => setConsent(fresh.consent))
          .catch((error: unknown) => console.error(error))
          .finally(() => {
            refreshing.current = false;
          });
      }),
    [setConsent]
  );

  // Without consent no health data stays in the browser: drop the caches as a sign-out does,
  // once the consent screen has replaced the app.
  useEffect(() => {
    if (!consentMissing) return;
    onSessionEnd?.();
    void clearSignedOutCaches();
  }, [consentMissing, onSessionEnd]);
  const value = useMemo<AuthState>(
    () => ({
      enabled: true,
      email: me?.email ?? null,
      athleteId: me?.athlete_id ?? null,
      isOwner: me?.is_owner ?? false,
      isAdmin: me?.is_admin ?? false,
      signOut: leave,
      grantGoogleScopes,
      consent: me?.consent ?? null,
      setConsent,
    }),
    [me, leave, grantGoogleScopes, setConsent]
  );

  if (!isLoaded) return <GateSpinner />;
  if (!isSignedIn) return <SignInPage />;
  if (leaving === 'misconfigured') {
    return (
      <GateScreen>
        <ErrorState
          message="Authentification mal configurée"
          onRetry={() => {
            setLeaving('yes');
            leave().catch(() => setLeaving('failed'));
          }}
        />
      </GateScreen>
    );
  }
  if (leaving === 'failed') {
    return (
      <GateScreen>
        <ErrorState
          message="Session expirée"
          onRetry={() => {
            setLeaving('yes');
            leave().catch(() => setLeaving('failed'));
          }}
        />
      </GateScreen>
    );
  }
  if (leaving === 'yes' || !current) return <GateSpinner />;
  if (current.status === 'error') {
    return (
      <GateScreen>
        <ErrorState message="Compte injoignable" onRetry={() => setAttempt((n) => n + 1)} />
      </GateScreen>
    );
  }
  if (current.status === 'refused') {
    return <AccountNotice message={current.detail ?? 'Accès refusé pour ce compte.'} signOut={leave} />;
  }
  if (current.me.athlete_id === null) {
    return (
      <AccountNotice
        message="Ton compte est créé, mais aucun athlète ne lui est encore associé. Demande l'accès au propriétaire de cette instance."
        email={current.me.email}
        signOut={leave}
      />
    );
  }
  if (consentMissing) {
    // The account is known: its deletion stays offered without consent (AccountDeletionPanel reads it).
    return (
      <AuthStateContext.Provider value={value}>
        <ConsentScreen consent={current.me.consent} email={current.me.email} onConsent={setConsent} signOut={leave} />
      </AuthStateContext.Provider>
    );
  }
  return <AuthStateContext.Provider key={key} value={value}>{children}</AuthStateContext.Provider>;
}

function SignInPage() {
  // Back to the page that asked for sign-in rather than Clerk's default "/".
  const here = `${window.location.pathname}${window.location.search}`;
  return (
    <GateScreen>
      <div className="flex flex-col items-center gap-6 animate-fade-up">
        <div className="text-center">
          <h1 className="text-text-primary"><AreteWordmark /></h1>
          <p className="mt-2 text-sm font-sans text-text-secondary">
            Connecte-toi pour retrouver ton entraînement.
          </p>
        </div>
        <SignIn routing="hash" fallbackRedirectUrl={here} />
      </div>
    </GateScreen>
  );
}

/** A signed-in account that cannot open the app (yet, or any more): why, as whom, and the way out. */
function AccountNotice({
  message,
  email,
  signOut,
}: {
  message: string;
  email?: string;
  signOut: () => Promise<void>;
}) {
  return (
    <GateScreen>
      <div className="glass-panel w-full max-w-md p-6 space-y-4 animate-fade-up">
        <h1 className="text-text-primary"><AreteWordmark /></h1>
        <p className="text-sm text-text-primary">{message}</p>
        {email && (
          <p className="text-xs font-sans text-text-muted">
            Connecté en tant que <span className="text-text-secondary">{email}</span>
          </p>
        )}
        <SignOutButton signOut={signOut} />
      </div>
    </GateScreen>
  );
}
