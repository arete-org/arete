import { createContext, useContext } from 'react';
import type { ConsentState } from '@/lib/api';

/** What the app knows about the signed-in account. */
export interface AuthState {
  /** Whether the server requires sign-in; false keeps the app exactly as before. */
  enabled: boolean;
  email: string | null;
  athleteId: number | null;
  isOwner: boolean;
  /** The owner or an admin: sees the administration tab. */
  isAdmin: boolean;
  /** Ends the session, drops the cached API answers and reloads; a no-op when sign-in is off. */
  signOut: () => Promise<void>;
  /**
   * Asks Google for more scopes on the signed-in Google account (adding one if the
   * user signed up by e-mail). Resolves true when the page is leaving for Google's
   * consent screen, false when everything was already granted. Rejects when
   * sign-in is off.
   */
  grantGoogleScopes: (scopes: string[], returnTo: string) => Promise<boolean>;
  /** The athlete's consent to the terms and to health data; null when sign-in is off (nothing is asked). */
  consent: ConsentState | null;
  /** Adopts the server's answer to a consent or a withdrawal: a withdrawal brings the consent screen back. */
  setConsent: (consent: ConsentState) => void;
}

export const AUTH_DISABLED: AuthState = {
  enabled: false,
  email: null,
  athleteId: 1,
  isOwner: false,
  isAdmin: false,
  signOut: async () => {},
  grantGoogleScopes: async () => {
    throw new Error('Connexion Google indisponible : la connexion au compte est désactivée.');
  },
  consent: null,
  setConsent: () => {},
};

/** Provided by the auth gate; components rendered without one see sign-in as off. */
export const AuthStateContext = createContext<AuthState>(AUTH_DISABLED);

export function useAuthState(): AuthState {
  return useContext(AuthStateContext);
}
