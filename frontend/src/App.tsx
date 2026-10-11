import type { CoachReference } from '@/lib/coachToday';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigation, ErrorBoundary } from '@/components';
import { AgentSidePanel } from '@/components/AgentSidePanel';
import { EnableNotifications } from '@/components/EnableNotifications';
import { InstallPrompt } from '@/components/InstallPrompt';
import { LoadingState } from '@/components/States';
import { AuthGate } from '@/components/auth/AuthGate';
import { SettingsProvider } from '@/contexts';
import { DashboardPage, PlanningPage, LogPage, SettingsPage } from '@/pages';

// recharts is most of the bundle and only the Analytics page draws charts.
const ProfilePage = lazy(() => import('@/pages/Profile').then(m => ({ default: m.ProfilePage })));
const AnalyticsPage = lazy(() =>
  import('@/pages/Analytics').then((m) => ({ default: m.AnalyticsPage })),
);
const SessionDetailPage = lazy(() =>
  import('@/pages/SessionDetail').then((m) => ({ default: m.SessionDetailPage })),
);
const YearReviewPage = lazy(() =>
  import('@/pages/YearReview').then((m) => ({ default: m.YearReviewPage })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
});

/** A session that ends takes the query cache with it; the page reloads right after. */
const dropQueryCache = () => queryClient.clear();

/** Route content can fade independently; the active chat is never remounted. */
function RouteContent({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <div key={pathname} className="route-content">{children}</div>;
}

function App() {
  // Panel state lives above the router so the drawer survives page navigation
  // (the agent's panel_context follows the route, the conversation too).
  const [agentOpen, setAgentOpen] = useState(false);
  const [coachReference, setCoachReference] = useState<CoachReference | null>(null);
  useEffect(() => {
    const discuss = (event: Event) => {
      const reference = (event as CustomEvent<CoachReference>).detail;
      if (!reference || !['proposal', 'followup'].includes(reference.kind) || !Number.isSafeInteger(reference.id)) return;
      setCoachReference(reference);
      setAgentOpen(true);
    };
    window.addEventListener('arete:coach-discuss', discuss);
    return () => window.removeEventListener('arete:coach-discuss', discuss);
  }, []);
  const [agentBusy, setAgentBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeAgent = useCallback(() => {
    setAgentOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <AuthGate onSessionEnd={dropQueryCache}>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <BrowserRouter>
            <div className="min-h-screen bg-void">
              <Navigation
                agentOpen={agentOpen}
                agentBusy={agentBusy}
                onToggleAgent={(event) => {
                  triggerRef.current = event.currentTarget;
                  setAgentOpen((v) => !v);
                }}
              />
              {/* pb-20 on mobile for bottom tab bar clearance, pb-0 on desktop */}
              <main
                className={`pb-20 md:pb-0 transition-[margin] duration-[220ms] motion-reduce:transition-none ${agentOpen ? 'xl:mr-[520px]' : ''}`}
              >
                <RouteContent>
                  <ErrorBoundary>
                    <Routes>
                      <Route path="/" element={<DashboardPage />} />
                      <Route path="/planning" element={<PlanningPage />} />
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
                      <Route path="/log" element={<LogPage />} />
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

              <AgentSidePanel
                reference={coachReference}
                onClearReference={() => setCoachReference(null)}
                open={agentOpen}
                onClose={closeAgent}
                onBusyChange={setAgentBusy}
              />
              <InstallPrompt />
              <EnableNotifications />
            </div>
          </BrowserRouter>
        </SettingsProvider>
      </QueryClientProvider>
    </AuthGate>
  );
}

export default App;
