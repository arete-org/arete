import { GarminFreshness } from '@/components/GarminFreshness';
import { RouteScroll } from '@/components/RouteScroll';
import { useVisualViewport } from '@/hooks/useVisualViewport';
import { useCoachDisplay } from '@/hooks/useCoachDisplay';
import { AreteMark } from '@/components/AreteBrand';
import { isCoachReference } from '@/lib/coachToday';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
import { loadLogPage, loadPlanningPage, loadWeekReviewPage } from '@/pages/routes';
import { importChunk } from '@/lib/chunkReload';

const FollowUpPage = lazy(importChunk(() => import('@/pages/FollowUp').then(m => ({ default: m.FollowUpPage }))));

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

function App() {
  useVisualViewport();
  // Panel state lives above the router so the drawer survives page navigation
  // (the agent's panel_context follows the route, the conversation too).
  const display = useCoachDisplay();
  const [agentOpen, setAgentOpen] = useState(false);
  useEffect(preloadAgentMarkdownWhenIdle, []);
  useEffect(() => {
    const discuss = (event: Event) => {
      const reference: unknown = (event as CustomEvent).detail;
      if (!isCoachReference(reference)) return;
      setAgentOpen(true);
    };
    const open = () => setAgentOpen(true);
    window.addEventListener('arete:coach-open', open);
    window.addEventListener('arete:coach-discuss', discuss);
    return () => { window.removeEventListener('arete:coach-discuss', discuss); window.removeEventListener('arete:coach-open', open); };
  }, []);
  const [agentBusy, setAgentBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const restoreCoachFocus = useRef(false);
  const closeAgent = useCallback(() => {
    restoreCoachFocus.current = true;
    setAgentOpen(false);
  }, []);
  useLayoutEffect(() => {
    if (!agentOpen && restoreCoachFocus.current) {
      restoreCoachFocus.current = false;
      // The floating launcher is mounted again only after closing the panel.
      const launcher = launcherRef.current;
      const desktopTrigger = document.querySelector<HTMLButtonElement>('nav[aria-label="Navigation principale"] button[aria-controls="coach-panel"]');
      const target = launcher?.getClientRects().length ? launcher : desktopTrigger ?? triggerRef.current;
      target?.focus({ preventScroll: true });
    }
  }, [agentOpen]);

  return (
    <AuthGate onSessionEnd={dropQueryCache}>
      <PersistedQueries>
        <SettingsProvider>
          <BrowserRouter>
            <div className="app-shell bg-void">
              <RouteScroll />
              <GarminFreshness />
              <Navigation
                agentOpen={agentOpen}
                agentBusy={agentBusy}
                onToggleAgent={(event) => {
                  triggerRef.current = event.currentTarget;
                  setAgentOpen((v) => !v);
                }}
              />
              {/* Reserve the tab bar and launcher so the final content remains reachable. */}
              <main
                className={`app-main transition-[margin] duration-[220ms] motion-reduce:transition-none ${agentOpen && display.mode === 'sidebar' ? 'xl:mr-[520px]' : ''}`}
              >
                <RouteContent>
                  <ErrorBoundary>
                    <Routes>
                      <Route path="/" element={<DashboardPage />} />
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
                      <Route path="/log" element={<Suspense fallback={<LoadingState message="Chargement de la page…" />}><LogPage /></Suspense>} />
                      <Route
                        path="/log/sessions/:id"
                        element={
                          <Suspense fallback={<LoadingState message="Chargement de la page…" />}>
                            <SessionDetailPage />
                          </Suspense>
                        }
                      />
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
                    </Routes>
                  </ErrorBoundary>
                </RouteContent>
              </main>

              {!agentOpen && <button
                ref={launcherRef}
                className={`coach-launcher ${display.mode === 'sidebar' ? 'md:hidden' : ''} fixed z-40 flex min-h-11 items-center gap-2 rounded-full border border-text-muted/20 bg-abyss px-4 text-sm text-text-primary shadow-lg`}
                aria-controls="coach-panel" aria-expanded={false}
                onClick={event => { triggerRef.current = event.currentTarget; setAgentOpen(true); }}
                onPointerEnter={preloadAgentMarkdown} onFocus={preloadAgentMarkdown}
              ><AreteMark size={18} />{agentBusy ? 'Chiron répond…' : 'Demander à Chiron'}</button>}
              <AgentSidePanel
                display={display.mode}
                onDisplayChange={display.setMode}
                displayError={display.error}
                open={agentOpen}
                onClose={closeAgent}
                onBusyChange={setAgentBusy}
              />
              <InstallPrompt />
              <EnableNotifications />
            </div>
          </BrowserRouter>
        </SettingsProvider>
      </PersistedQueries>
    </AuthGate>
  );
}

export default App;
