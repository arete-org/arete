import { AppNotices } from '@/components/AppNotices';
import { GarminFreshness } from '@/components/GarminFreshness';
import { RouteScroll } from '@/components/RouteScroll';
import { useVisualViewport } from '@/hooks/useVisualViewport';
import { AreteMark } from '@/components/AreteBrand';
import { isCoachReference } from '@/lib/coachToday';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Navigation, ErrorBoundary } from '@/components';
import { AgentSidePanel } from '@/components/AgentSidePanel';
import { preloadAgentMarkdown, preloadAgentMarkdownWhenIdle } from '@/components/agent/markdownRenderer';
import { EnableNotifications } from '@/components/EnableNotifications';
import { InstallPrompt } from '@/components/InstallPrompt';
import { LoadingState } from '@/components/States';
import { AuthGate } from '@/components/auth/AuthGate';
import { useAuthState } from '@/components/auth/authState';
import { athletePersister, keepPersistedQueries, PERSIST_BUSTER, PERSIST_DEHYDRATE, PERSIST_MAX_AGE_MS } from '@/lib/queryPersistence';
import { SettingsProvider } from '@/contexts';
import { DashboardPage, SettingsPage } from '@/pages';
import { OnboardingEntry } from '@/components/OnboardingEntry';
import { loadLogPage, loadPlanningPage, loadWeekReviewPage } from '@/pages/routes';
import { importChunk } from '@/lib/chunkReload';
import { useCoachWords } from '@/lib/coachName';

const FollowUpPage = lazy(importChunk(() => import('@/pages/FollowUp').then(m => ({ default: m.FollowUpPage }))));
const NotFoundPage = lazy(importChunk(() => import('@/pages/NotFound').then(m => ({ default: m.NotFoundPage }))));
const OnboardingPage = lazy(importChunk(() => import('@/pages/Onboarding').then(m => ({ default: m.OnboardingPage }))));

const DesignSystemPage = import.meta.env.DEV ? lazy(() => import('@/pages/DesignSystem')) : null;

const PlanningPage = lazy(importChunk(loadPlanningPage));
const LogPage = lazy(importChunk(loadLogPage));
const WeekReviewPage = lazy(importChunk(loadWeekReviewPage));
// recharts is most of the bundle and only the Analytics page draws charts.
const ProfilePage = lazy(importChunk(() => import('@/pages/Profile').then(m => ({ default: m.ProfilePage }))));
const AnalyticsPage = lazy(importChunk(() =>
  import('@/pages/Analytics').then((m) => ({ default: m.AnalyticsPage })),
));
const SessionDetailPage = lazy(importChunk(() =>
  import('@/pages/SessionDetail').then((m) => ({ default: m.SessionDetailPage })),
));
const YearReviewPage = lazy(importChunk(() =>
  import('@/pages/YearReview').then((m) => ({ default: m.YearReviewPage })),
));
const GlossaryPage = lazy(importChunk(() =>
  import('@/pages/Glossary').then((m) => ({ default: m.GlossaryPage })),
));
const HealthPage = lazy(importChunk(() => import('@/pages/Health').then((m) => ({ default: m.HealthPage }))));
const HealthReportPage = lazy(importChunk(() =>
  import('@/pages/HealthReport').then((m) => ({ default: m.HealthReportPage })),
));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
});

keepPersistedQueries(queryClient);

const revalidateRestored = () => queryClient.invalidateQueries();
const FOCUS_RESTORE_TIMEOUT_MS = 2000;

/** A session that ends takes the query cache with it; the page reloads right after. */
const dropQueryCache = () => queryClient.clear();

/** A repeat visit paints this athlete's last answers while they revalidate. */
function PersistedQueries({ children }: { children: ReactNode }) {
  const { athleteId } = useAuthState();
  if (athleteId === null) throw new Error('Athlète absent.');
  const persistOptions = useMemo(() => ({
    persister: athletePersister(athleteId),
    maxAge: PERSIST_MAX_AGE_MS,
    buster: PERSIST_BUSTER,
    dehydrateOptions: PERSIST_DEHYDRATE,
  }), [athleteId]);
  // Restored answers may predate a write the last page made just before closing
  // (an IndexedDB write does not outlive the page): they paint, then revalidate.
  return (
    <PersistQueryClientProvider key={athleteId} client={queryClient} persistOptions={persistOptions} onSuccess={revalidateRestored}>
      {children}
    </PersistQueryClientProvider>
  );
}

/** Route content can fade independently; the active chat is never remounted. */
function RouteContent({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <div key={pathname} className="route-content">{children}</div>;
}

/** The launcher reads the opt-in below the query provider that App mounts. */
function CoachLauncherLabel({ busy }: { busy: boolean }) {
  const coach = useCoachWords();
  return <>{busy ? `${coach.The} répond…` : `Demander ${coach.to}`}</>;
}

function OutsideOnboarding({ children }: { children: ReactNode }) {
  return useLocation().pathname === '/onboarding' ? null : children;
}

/** The chat owner stays mounted inside main; routes only change its visibility. */
function ProductShell() {
  useVisualViewport();
  const location = useLocation();
  const navigate = useNavigate();
  const agentOpen = location.pathname === '/coach';
  const setAgentOpen = useCallback((value: boolean | ((open: boolean) => boolean)) => {
    const open = typeof value === 'function' ? value(agentOpen) : value;
    if (open === agentOpen) return;
    if (open) {
      const params = new URLSearchParams(location.search);
      const triggered = location.pathname === '/follow-up' && ['run', 'evening', 'proposal', 'followup', 'thread'].some(key => params.has(key));
      if (triggered) for (const key of ['run', 'evening', 'proposal', 'followup', 'thread']) params.delete(key);
      navigate('/coach', { replace: triggered, state: { coachFrom: { pathname: location.pathname, search: params.toString() ? `?${params}` : '' }, coachReturnReplace: triggered } });
    }
    else if (location.state?.coachReturnReplace) navigate(location.state.coachFrom, { replace: true });
    else if (location.state?.coachFrom) navigate(-1);
    else navigate('/');
  }, [agentOpen, location, navigate]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pageEntryOpened = useRef(false);
  const openCoachRef = useRef(setAgentOpen);
  useLayoutEffect(() => { openCoachRef.current = setAgentOpen; }, [setAgentOpen]);
  useEffect(preloadAgentMarkdownWhenIdle, []);
  useLayoutEffect(() => {
    const discuss = (event: Event) => {
      const reference: unknown = (event as CustomEvent).detail;
      if (!isCoachReference(reference)) return;
      triggerRef.current = null;
      pageEntryOpened.current = false;
      openCoachRef.current(true);
    };
    const open = () => { triggerRef.current = null; pageEntryOpened.current = false; openCoachRef.current(true); };
    window.addEventListener('arete:coach-open', open);
    window.addEventListener('arete:coach-discuss', discuss);
    return () => { window.removeEventListener('arete:coach-discuss', discuss); window.removeEventListener('arete:coach-open', open); };
  }, []);
  const [agentBusy, setAgentBusy] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const restoreCoachFocus = useRef(false);
  const closeAgent = useCallback(() => {
    restoreCoachFocus.current = true;
    setAgentOpen(false);
  }, [setAgentOpen]);
  useLayoutEffect(() => {
    if (!agentOpen && restoreCoachFocus.current) {
      restoreCoachFocus.current = false;
      // The page entry is mounted again only after returning from the conversation.
      const launcher = launcherRef.current;
      const desktopTrigger = document.querySelector<HTMLButtonElement>('nav[aria-label="Navigation principale"] button[aria-controls="coach-panel"]');
      const target = triggerRef.current?.isConnected ? triggerRef.current : launcher?.getClientRects().length ? launcher : desktopTrigger;
      // Returning from the page entry must reveal its restored focus, even when
      // the source page grew while the conversation was open.
      target?.focus({ preventScroll: !pageEntryOpened.current });
      if (!target || !pageEntryOpened.current) return;
      // Lazy route content can push the entry below the viewport after focus.
      // Follow that layout briefly, but never override a person's next action.
      const observer = new ResizeObserver(() => {
        if (document.activeElement !== target) { stop(); return; }
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      const stop = () => {
        observer.disconnect();
        clearTimeout(timer);
        window.removeEventListener('touchstart', stop);
        window.removeEventListener('wheel', stop);
        window.removeEventListener('keydown', stop);
        target.removeEventListener('blur', stop);
      };
      const timer = setTimeout(stop, FOCUS_RESTORE_TIMEOUT_MS);
      observer.observe(document.body);
      window.addEventListener('touchstart', stop, { passive: true });
      window.addEventListener('wheel', stop, { passive: true });
      window.addEventListener('keydown', stop);
      target.addEventListener('blur', stop);
      return stop;
    }
  }, [agentOpen]);

  return (
    <div className="app-shell bg-void">
      <RouteScroll />
      <AppNotices />
      <OutsideOnboarding><GarminFreshness />
      <Navigation
        agentOpen={agentOpen}
        agentBusy={agentBusy}
        onToggleAgent={(event) => {
          triggerRef.current = event.currentTarget;
          pageEntryOpened.current = false;
          setAgentOpen((v) => !v);
        }}
      />
      </OutsideOnboarding>
      {/* Keep product navigation outside the changing page and conversation. */}
      <main className={`app-main ${agentOpen ? 'app-main-coach' : ''}`}>
        <RouteContent>
          <ErrorBoundary>
            <Routes>
              <Route path="/coach" element={null} />
              <Route path="/" element={<><OnboardingEntry /><DashboardPage /></>} />
              <Route path="/onboarding" element={<Suspense fallback={<LoadingState message="Chargement de ta configuration…" />}><OnboardingPage /></Suspense>} />
              {DesignSystemPage && <Route path="/design-system" element={<Suspense fallback={<LoadingState />}><DesignSystemPage /></Suspense>} />}
              <Route path="/planning/objectifs" element={<SettingsPage planningGoals />} />
              <Route path="/follow-up" element={<FollowUpPage />} />
              <Route path="/planning" element={<Suspense fallback={<LoadingState message="Chargement de la page…" />}><PlanningPage /></Suspense>} />
              <Route path="/planning/semaine" element={<Suspense fallback={<LoadingState message="Chargement de la page…" />}><WeekReviewPage /></Suspense>} />
              <Route
                path="/analytics"
                element={
                  <Suspense fallback={<LoadingState message="Chargement de la page…" />}>
                    <AnalyticsPage />
                  </Suspense>
                }
              />
              <Route
                path="/analytics/bilan"
                element={
                  <Suspense fallback={<LoadingState message="Chargement de la page…" />}>
                    <YearReviewPage />
                  </Suspense>
                }
              />
              <Route
                path="/analytics/lexique"
                element={
                  <Suspense fallback={<LoadingState message="Chargement de la page…" />}>
                    <GlossaryPage />
                  </Suspense>
                }
              />
              <Route path="/log" element={<Suspense fallback={<LoadingState message="Chargement de la page…" />}><LogPage /></Suspense>} />
              <Route
                path="/log/sessions/:id"
                element={
                  <Suspense fallback={<LoadingState message="Chargement de la page…" />}>
                    <SessionDetailPage />
                  </Suspense>
                }
              />
              <Route path="/sante" element={<Suspense fallback={<LoadingState message="Chargement de la page…" />}><HealthPage /></Suspense>} />
              <Route path="/sante/rapport" element={<Suspense fallback={<LoadingState message="Chargement du rapport…" />}><HealthReportPage /></Suspense>} />
              <Route path="/profile" element={<Suspense fallback={<LoadingState message="Chargement de la page…" />}><ProfilePage /></Suspense>} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* Legacy redirects */}
              <Route
                path="/quest-log"
                element={<Navigate to="/planning" replace />}
              />
              <Route
                path="/forge"
                element={<Navigate to="/log" replace />}
              />
              <Route
                path="/matrix"
                element={<Navigate to="/settings" replace />}
              />
              <Route
                path="/neural-link"
                element={<Navigate to="/" replace />}
              />
              <Route path="*" element={<Suspense fallback={<LoadingState message="Chargement de la page…" />}><NotFoundPage /></Suspense>} />
            </Routes>
          </ErrorBoundary>
        </RouteContent>
        <AgentSidePanel
          embedded
          open={agentOpen}
          onClose={closeAgent}
          onBusyChange={setAgentBusy}
        />
        <OutsideOnboarding>{!agentOpen && <div className="coach-entry">
          <button ref={launcherRef} className="ui-button inline-flex min-h-11 items-center gap-2 border border-border bg-abyss px-4 text-sm"
            aria-controls="coach-panel" aria-expanded={false}
            onClick={event => { triggerRef.current = event.currentTarget; pageEntryOpened.current = true; setAgentOpen(true); }}
            onPointerEnter={preloadAgentMarkdown} onFocus={preloadAgentMarkdown}
          ><AreteMark size={18} /><CoachLauncherLabel busy={agentBusy} /></button>
        </div>}</OutsideOnboarding>
      </main>
      <OutsideOnboarding><InstallPrompt /><EnableNotifications /></OutsideOnboarding>
    </div>
  );
}

function App() {
  return <AuthGate onSessionEnd={dropQueryCache}>
    <PersistedQueries><SettingsProvider><BrowserRouter><ProductShell /></BrowserRouter></SettingsProvider></PersistedQueries>
  </AuthGate>;
}

export default App;
