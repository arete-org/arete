/**
 * @description: Defines the web app route tree and stitches together the landing page and standalone pages.
 * @footnote-scope: web
 * @footnote-module: WebAppRoutes
 * @footnote-risk: medium - Routing mistakes can hide key web surfaces or send users to broken pages.
 * @footnote-ethics: medium - The top-level route map affects access to transparency and self-hosting guidance.
 */

import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import Header from '@components/Header';
import Hero from '@components/Hero';
import Footer from '@components/Footer';

const loadTracePage = (): Promise<typeof import('@pages/TracePage')> =>
    import('@pages/TracePage');
const loadDownloadPage = (): Promise<typeof import('@pages/DownloadPage')> =>
    import('@pages/DownloadPage');
const loadEmbedPage = (): Promise<typeof import('@pages/EmbedPage')> =>
    import('@pages/EmbedPage');
const loadAboutPage = (): Promise<typeof import('@pages/AboutPage')> =>
    import('@pages/AboutPage');
const loadOnboardingPage = (): Promise<typeof import('@pages/OnboardingPage')> =>
    import('@pages/OnboardingPage');

const TracePage = lazy(loadTracePage);
const DownloadPage = lazy(loadDownloadPage);
const EmbedPage = lazy(loadEmbedPage);
const AboutPage = lazy(loadAboutPage);
const OnboardingPage = lazy(loadOnboardingPage);

const routeFallback = (
    <main id="main-content" className="route-loading-shell">
        <section
            className="route-loading-card"
            aria-label="Page loading state"
            role="status"
            aria-live="polite"
        >
            <div className="spinner route-loading-spinner" aria-hidden="true" />
            <p className="route-loading-title">Loading page...</p>
        </section>
    </main>
);

// The App component stitches together the landing page sections in their intended scroll order.
const App = (): JSX.Element => {
    useEffect(() => {
        const windowWithIdleCallbacks = window as typeof globalThis & {
            requestIdleCallback?: (callback: () => void) => number;
            cancelIdleCallback?: (handle: number) => void;
        };

        const preloadRoutes = (): void => {
            void Promise.allSettled([
                loadTracePage(),
                loadDownloadPage(),
                loadEmbedPage(),
                loadAboutPage(),
                loadOnboardingPage(),
            ]);
        };

        if (typeof windowWithIdleCallbacks.requestIdleCallback === 'function') {
            const idleCallbackId = windowWithIdleCallbacks.requestIdleCallback(() => {
                preloadRoutes();
            });

            return (): void => {
                windowWithIdleCallbacks.cancelIdleCallback?.(idleCallbackId);
            };
        }

        const timeoutId = window.setTimeout(preloadRoutes, 900);

        return (): void => {
            window.clearTimeout(timeoutId);
        };
    }, []);

    return (
        <div className="app-shell">
            <a href="#main-content" className="skip-link">
                Skip to main content
            </a>
            <Routes>
            <Route
                path="/"
                element={
                    <>
                        <Header breadcrumbItems={[]} />
                        <main id="main-content">
                            <Hero />
                            <Footer />
                        </main>
                    </>
                }
            />
            <Route
                path="/download"
                element={
                    <Suspense fallback={routeFallback}>
                        <DownloadPage />
                    </Suspense>
                }
            />
            <Route
                path="/download/"
                element={
                    <Suspense fallback={routeFallback}>
                        <DownloadPage />
                    </Suspense>
                }
            />
            <Route
                path="/about"
                element={
                    <Suspense fallback={routeFallback}>
                        <AboutPage />
                    </Suspense>
                }
            />
            <Route
                path="/about/"
                element={
                    <Suspense fallback={routeFallback}>
                        <AboutPage />
                    </Suspense>
                }
            />
            <Route
                path="/onboarding"
                element={
                    <Suspense fallback={routeFallback}>
                        <OnboardingPage />
                    </Suspense>
                }
            />
            <Route
                path="/onboarding/"
                element={
                    <Suspense fallback={routeFallback}>
                        <OnboardingPage />
                    </Suspense>
                }
            />
            <Route
                path="/embed"
                element={
                    <Suspense fallback={routeFallback}>
                        <EmbedPage />
                    </Suspense>
                }
            />
            <Route
                path="/traces/:responseId"
                element={
                    <Suspense fallback={routeFallback}>
                        <TracePage />
                    </Suspense>
                }
            />
            <Route
                path="/api/traces/:responseId"
                element={
                    <Suspense fallback={routeFallback}>
                        <TracePage />
                    </Suspense>
                }
            />
            </Routes>
        </div>
    );
};

export default App;
