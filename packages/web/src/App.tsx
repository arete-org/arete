/**
 * @description: Defines the web app route tree and stitches together the landing page and standalone pages.
 * @footnote-scope: web
 * @footnote-module: WebAppRoutes
 * @footnote-risk: medium - Routing mistakes can hide key web surfaces or send users to broken pages.
 * @footnote-ethics: medium - The top-level route map affects access to transparency and self-hosting guidance.
 */

import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Header from '@components/Header';
import Hero from '@components/Hero';
import Footer from '@components/Footer';

const TracePage = lazy(() => import('@pages/TracePage'));
const DownloadPage = lazy(() => import('@pages/DownloadPage'));
const BlogListPage = lazy(() => import('@pages/BlogListPage'));
const BlogPostPage = lazy(() => import('@pages/BlogPostPage'));
const EmbedPage = lazy(() => import('@pages/EmbedPage'));
const AboutPage = lazy(() => import('@pages/AboutPage'));
const OnboardingPage = lazy(() => import('@pages/OnboardingPage'));

const routeFallback = (
    <main id="main-content" className="route-loading-shell">
        <section
            className="route-loading-card"
            aria-label="Page loading state"
            role="status"
            aria-live="polite"
        >
            <div className="spinner route-loading-spinner" aria-hidden="true" />
            <div className="route-loading-copy">
                <p className="route-loading-title">Loading page...</p>
                <p className="route-loading-detail">
                    Preparing Footnote interface
                </p>
            </div>
        </section>
    </main>
);

// The App component stitches together the landing page sections in their intended scroll order.
const App = (): JSX.Element => (
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
                path="/blog"
                element={
                    <Suspense fallback={routeFallback}>
                        <BlogListPage />
                    </Suspense>
                }
            />
            <Route
                path="/blog/"
                element={
                    <Suspense fallback={routeFallback}>
                        <BlogListPage />
                    </Suspense>
                }
            />
            <Route
                path="/blog/:number"
                element={
                    <Suspense fallback={routeFallback}>
                        <BlogPostPage />
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

export default App;
