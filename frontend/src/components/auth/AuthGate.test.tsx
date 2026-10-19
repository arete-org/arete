// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchAPI } from '@/lib/api';
import { authHeaders, setTokenGetter } from '@/lib/auth';
import { AuthGate } from './AuthGate';
import { useAuthState } from './authState';

const clerk = vi.hoisted(() => ({
  /** Called when the mocked SDK module is first evaluated, i.e. when the gate loads it. */
  loaded: vi.fn(),
  signedIn: false,
  getToken: vi.fn(async () => 'jeton'),
  signOut: vi.fn(async (then?: () => Promise<void>) => {
    await then?.();
  }),
}));

vi.mock('@clerk/react', () => {
  clerk.loaded();
  return {
    ClerkProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    SignIn: () => <div>Formulaire Clerk</div>,
    UserButton: () => <div>Compte</div>,
    useAuth: () => ({
      isLoaded: true,
      isSignedIn: clerk.signedIn,
      sessionId: clerk.signedIn ? 'sess_1' : null,
      getToken: clerk.getToken,
      signOut: clerk.signOut,
    }),
    useUser: () => ({ user: null }),
  };
});
vi.mock('@clerk/localizations/fr-FR', () => ({ frFR: {} }));

const persistence = vi.hoisted(() => ({ clear: vi.fn(async () => {}) }));
vi.mock('@/lib/queryPersistence', async (original) => ({
  ...(await original<typeof import('@/lib/queryPersistence')>()),
  clearPersistedQueries: persistence.clear,
}));

interface Consent {
  required: boolean;
  current: boolean;
  terms_version: string;
  privacy_version: string;
  latest: {
    terms_version: string;
    privacy_version: string;
    health_data: boolean;
    consented_at: string;
    withdrawn_at: string | null;
  } | null;
}

interface Me {
  email: string;
  name: string | null;
  athlete_id: number | null;
  is_owner: boolean;
  role: 'athlete' | 'admin';
  is_admin: boolean;
  consent: Consent;
}

/** The version this build's texts carry in their header. */
const VERSION = '2026-10-draft-1';
const TEXTS_CHANGED =
  "Les textes ont changé depuis l'ouverture de la page : recharge-la pour lire la nouvelle version.";
const NOT_ASKED: Consent = {
  required: true,
  current: false,
  terms_version: VERSION,
  privacy_version: VERSION,
  latest: null,
};
const GIVEN: Consent = {
  ...NOT_ASKED,
  current: true,
  latest: {
    terms_version: VERSION,
    privacy_version: VERSION,
    health_data: true,
    consented_at: '2026-10-18T08:30:00Z',
    withdrawn_at: null,
  },
};

/** The server turning the account away, with its reason. */
interface Refusal {
  status: number;
  detail: string;
}

/** Answers the gate endpoints (and a consent) and records every request. */
function server(config: unknown, me?: Me | Refusal) {
  const requests: { url: string; headers: Headers; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url === '/api/auth/consent') {
        // As the server does: only the versions it publishes are accepted.
        const published = me && !('detail' in me) ? me.consent : NOT_ASKED;
        const answer = JSON.parse(String(init?.body)) as { terms_version: string; privacy_version: string };
        if (answer.terms_version !== published.terms_version || answer.privacy_version !== published.privacy_version) {
          return new Response(JSON.stringify({ detail: TEXTS_CHANGED }), { status: 409 });
        }
        return new Response(JSON.stringify(GIVEN), { status: 200 });
      }
      if (url === '/api/auth/me/delete') return new Response(null, { status: 204 });
      if (url === '/api/auth/config') {
        if (config instanceof Error) throw config;
        return new Response(JSON.stringify(config), { status: 200 });
      }
      if (url === '/api/auth/me') {
        if (!me) return new Response('{"detail":"Non authentifié"}', { status: 401 });
        return 'detail' in me
          ? new Response(JSON.stringify({ detail: me.detail }), { status: me.status })
          : new Response(JSON.stringify(me), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    })
  );
  return requests;
}

const enabled = { enabled: true, publishable_key: 'pk_test_x' };
const disabled = { enabled: false, publishable_key: null };

function mount() {
  return render(
    <AuthGate>
      <p>Tableau de bord</p>
    </AuthGate>
  );
}

afterEach(() => {
  cleanup();
  setTokenGetter(null);
  clerk.signedIn = false;
  clerk.signOut.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Sign-in configuration baked into the build, as Vercel sets it per environment. */
function built(key = 'pk_test_build') {
  vi.stubEnv('VITE_AUTH_ENABLED', 'true');
  vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', key);
}

// Runs first on purpose: the SDK module is loaded once per file, by the first gate that needs it.
it('renders the app as before, without the Clerk SDK, when sign-in is off', async () => {
  const requests = server(disabled);
  mount();
  expect(await screen.findByText('Tableau de bord')).toBeTruthy();
  expect(clerk.loaded).not.toHaveBeenCalled();
  expect(requests.map((r) => r.url)).toEqual(['/api/auth/config']);
  expect(requests[0].headers.has('Authorization')).toBe(false);
  expect(await authHeaders()).toEqual({});
});

it('exposes local administration only after the server confirms sign-in is off', async () => {
  server(disabled);
  function Permissions() {
    const { isAdmin, isOwner } = useAuthState();
    return <p>{isAdmin && isOwner ? 'Administration locale' : 'Athlète'}</p>;
  }
  render(<AuthGate><Permissions /></AuthGate>);
  expect(screen.queryByText('Administration locale')).toBeNull();
  expect(await screen.findByText('Administration locale')).toBeTruthy();
});

it('offers a retry, never the app, when the config cannot be fetched', async () => {
  server(new Error('réseau'));
  mount();
  expect(await screen.findByText('SERVEUR INJOIGNABLE')).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  server(disabled);
  fireEvent.click(screen.getByRole('button', { name: 'RÉESSAYER' }));
  expect(await screen.findByText('Tableau de bord')).toBeTruthy();
});

it('shows the sign-in page when signed out', async () => {
  const requests = server(enabled);
  mount();
  expect(await screen.findByText('Formulaire Clerk')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'ARETE' })).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  expect(requests.map((r) => r.url)).toEqual(['/api/auth/config']);
});

it('shows the waiting page with the email while no athlete is attached', async () => {
  clerk.signedIn = true;
  const requests = server(enabled, {
    email: 'ana@exemple.fr',
    name: null,
    athlete_id: null,
    is_owner: false,
    role: 'athlete',
    is_admin: false,
    consent: NOT_ASKED,
  });
  mount();
  expect(await screen.findByText(/aucun athlète ne lui est encore associé/)).toBeTruthy();
  expect(screen.getByText('ana@exemple.fr')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  const me = requests.find((r) => r.url === '/api/auth/me');
  expect(me?.headers.get('Authorization')).toBe('Bearer jeton');
});

it('renders the app once an athlete is attached', async () => {
  clerk.signedIn = true;
  server(enabled, {
    email: 'ana@exemple.fr',
    name: 'Ana',
    athlete_id: 1,
    is_owner: true,
    role: 'athlete',
    is_admin: true,
    consent: GIVEN,
  });
  mount();
  expect(await screen.findByText('Tableau de bord')).toBeTruthy();
  expect(await authHeaders()).toEqual({ Authorization: 'Bearer jeton' });
});

const FRESH: Me = {
  email: 'ana@exemple.fr',
  name: 'Ana',
  athlete_id: 2,
  is_owner: false,
  role: 'athlete',
  is_admin: false,
  consent: NOT_ASKED,
};

it('blocks a fresh account behind the texts and two unticked boxes until it consents', async () => {
  clerk.signedIn = true;
  const requests = server(enabled, FRESH);
  mount();
  expect(await screen.findByText(/rien n’est synchronisé, analysé ni envoyé au coach/)).toBeTruthy();
  // An existing athlete meets this screen after the migration: their data stays, and leaves.
  expect(screen.getByText(/Les données déjà enregistrées sont conservées/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Exporter mes données/ })).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  expect(screen.getByRole('button', { name: "Lire : Conditions d'utilisation" })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Lire : Politique de confidentialité' })).toBeTruthy();
  const [terms, health] = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect([terms.checked, health.checked]).toEqual([false, false]);
  expect(health.closest('label')?.textContent).toMatch(/article 9 du RGPD/);
  const accept = screen.getByRole('button', { name: /ACCEPTER ET CONTINUER/ }) as HTMLButtonElement;
  expect(accept.disabled).toBe(true);
  fireEvent.click(terms);
  expect(accept.disabled).toBe(true); // the health data box is a separate, explicit choice
  fireEvent.click(health);
  expect(accept.disabled).toBe(false);

  fireEvent.click(accept);
  expect(await screen.findByText('Tableau de bord')).toBeTruthy();
  const consent = requests.find((r) => r.url === '/api/auth/consent');
  expect(consent?.body).toEqual({
    terms_version: VERSION,
    privacy_version: VERSION,
    terms_accepted: true,
    health_data: true,
  });
  expect(consent?.headers.get('Authorization')).toBe('Bearer jeton');
});

it('tells a withdrawn athlete their data is kept, and offers the export and the way back', async () => {
  clerk.signedIn = true;
  server(enabled, {
    ...FRESH,
    consent: { ...GIVEN, current: false, latest: { ...GIVEN.latest!, withdrawn_at: '2026-10-18T09:00:00Z' } },
  });
  mount();
  expect(await screen.findByText(/Tu as retiré ton consentement le 18 octobre 2026/)).toBeTruthy();
  expect(screen.getByText(/Tes données sont conservées/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Exporter mes données/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
});

it('lets an athlete who does not consent erase their account from the consent screen', async () => {
  clerk.signedIn = true;
  const requests = server(enabled, { ...FRESH, consent: NOT_ASKED });
  mount();
  fireEvent.change(await screen.findByLabelText('Tape SUPPRIMER pour confirmer'), { target: { value: 'SUPPRIMER' } });
  fireEvent.click(screen.getByRole('button', { name: /SUPPRIMER DÉFINITIVEMENT/ }));
  await waitFor(() => expect(clerk.signOut).toHaveBeenCalled());
  const deletion = requests.find((r) => r.url === '/api/auth/me/delete');
  expect(deletion?.body).toEqual({ confirmation: 'SUPPRIMER' });
  expect(screen.queryByText('Tableau de bord')).toBeNull();
});

it('asks again when the texts have a new version', async () => {
  clerk.signedIn = true;
  server(enabled, { ...FRESH, consent: { ...GIVEN, current: false, terms_version: '2027-01' } });
  mount();
  expect(await screen.findByText(/ont changé/)).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
});

it('accepts the versions of the texts shown, so a page older than the server is refused', async () => {
  clerk.signedIn = true;
  // The server publishes a version this build does not carry yet.
  const requests = server(enabled, { ...FRESH, consent: { ...NOT_ASKED, terms_version: '2027-01' } });
  mount();
  const [terms, health] = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
  fireEvent.click(terms);
  fireEvent.click(health);
  fireEvent.click(screen.getByRole('button', { name: /ACCEPTER ET CONTINUER/ }));
  expect(await screen.findByText(TEXTS_CHANGED)).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  const consent = requests.find((r) => r.url === '/api/auth/consent');
  expect(consent?.body).toMatchObject({ terms_version: VERSION, privacy_version: VERSION });
});

it('shows the refusal reason with a sign-out when the account is deactivated', async () => {
  clerk.signedIn = true;
  server(enabled, { status: 403, detail: 'Ce compte a été désactivé.' });
  mount();
  expect(await screen.findByText('Ce compte a été désactivé.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  expect(screen.queryByText('COMPTE INJOIGNABLE')).toBeNull();
});

it('starts Clerk from the build configuration without asking the server', async () => {
  built();
  const requests = server(new Error('the server must not be asked'));
  mount();
  expect(await screen.findByText('Formulaire Clerk')).toBeTruthy();
  expect(requests).toEqual([]);
});

it('never lets the build turn sign-in off: anything but true asks the server', async () => {
  vi.stubEnv('VITE_AUTH_ENABLED', 'false');
  const requests = server(enabled);
  mount();
  expect(await screen.findByText('Formulaire Clerk')).toBeTruthy();
  expect(requests.map((r) => r.url)).toEqual(['/api/auth/config']);
});

it('reports a build that enables sign-in without its key', async () => {
  built('');
  const requests = server(enabled);
  mount();
  expect(await screen.findByText('AUTHENTIFICATION MAL CONFIGURÉE')).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  expect(requests).toEqual([]);
});

it('shows a misconfiguration, not a sign-out loop, when the server expects another Clerk instance', async () => {
  built('pk_test_build');
  clerk.signedIn = true;
  const requests = server({ enabled: true, publishable_key: 'pk_test_server' });
  mount();
  expect(await screen.findByText('AUTHENTIFICATION MAL CONFIGURÉE')).toBeTruthy();
  expect(screen.queryByText('Tableau de bord')).toBeNull();
  expect(clerk.signOut).not.toHaveBeenCalled();
  // The server was asked only after it refused the session.
  expect(requests.map((r) => r.url)).toEqual(['/api/auth/me', '/api/auth/config']);
});

it('ends a refused session as before when the server expects the same instance', async () => {
  built('pk_test_build');
  clerk.signedIn = true;
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  server({ enabled: true, publishable_key: 'pk_test_build' });
  mount();
  await waitFor(() => expect(clerk.signOut).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(reload).toHaveBeenCalled());
  expect(screen.queryByText('AUTHENTIFICATION MAL CONFIGURÉE')).toBeNull();
});

const WITHDRAWN: Consent = {
  ...GIVEN,
  current: false,
  latest: { ...GIVEN.latest!, withdrawn_at: '2026-10-18T09:00:00Z' },
};

/** The signed-in app, answering `/api/settings` as told; the probe loads it or withdraws. */
function signedInApp(answers: { consent: () => Consent; settings: () => Response }) {
  clerk.signedIn = true;
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      if (url === '/api/auth/config') return new Response(JSON.stringify(enabled), { status: 200 });
      if (url === '/api/auth/me') {
        return new Response(JSON.stringify({ ...FRESH, consent: answers.consent() }), { status: 200 });
      }
      if (url === '/api/settings') return answers.settings();
      throw new Error(`unexpected request: ${url}`);
    })
  );
  const ended = vi.fn();
  function Probe() {
    const { setConsent } = useAuthState();
    return (
      <>
        <button type="button" onClick={() => void fetchAPI('/settings').catch(() => {})}>
          Charger
        </button>
        <button type="button" onClick={() => setConsent(WITHDRAWN)}>
          Retirer
        </button>
      </>
    );
  }
  render(
    <AuthGate onSessionEnd={ended}>
      <Probe />
    </AuthGate>
  );
  return { asked, ended };
}

it('goes back to the consent screen when a request is refused for missing consent mid-session', async () => {
  let consent = GIVEN;
  let marked = false;
  const { asked, ended } = signedInApp({
    consent: () => consent,
    settings: () =>
      new Response(JSON.stringify({ detail: 'Accepte…' }), {
        status: 403,
        headers: marked ? { 'X-Arete-Consent': 'required' } : {},
      }),
  });
  const load = await screen.findByRole('button', { name: 'Charger' });
  const sessionStart = ended.mock.calls.length;

  // Any other 403 (an admin route, say) leaves the account alone.
  fireEvent.click(load);
  await waitFor(() => expect(asked.filter((u) => u === '/api/settings')).toHaveLength(1));
  expect(asked.filter((u) => u === '/api/auth/me')).toHaveLength(1);

  // A new text version was published meanwhile: the marked 403 asks the account again.
  consent = { ...GIVEN, current: false, terms_version: '2027-01' };
  marked = true;
  fireEvent.click(load);
  expect(await screen.findByText(/ont changé/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Charger' })).toBeNull();
  expect(asked.filter((u) => u === '/api/auth/me')).toHaveLength(2);
  // Nothing of the athlete's stays cached once the app is gone.
  await waitFor(() => expect(persistence.clear).toHaveBeenCalled());
  expect(ended.mock.calls.length).toBeGreaterThan(sessionStart);
});

it('drops the in-memory and persisted caches when the athlete withdraws', async () => {
  persistence.clear.mockClear();
  const { ended } = signedInApp({ consent: () => GIVEN, settings: () => new Response('{}') });
  fireEvent.click(await screen.findByRole('button', { name: 'Retirer' }));
  expect(await screen.findByText(/Tu as retiré ton consentement/)).toBeTruthy();
  await waitFor(() => expect(persistence.clear).toHaveBeenCalledTimes(1));
  expect(ended).toHaveBeenCalledTimes(2); // the session's start, then the withdrawal
});
