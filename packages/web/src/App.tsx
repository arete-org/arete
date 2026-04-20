/**
 * @description: Defines the web app route tree and stitches together the landing page and standalone pages.
 * @footnote-scope: web
 * @footnote-module: WebAppRoutes
 * @footnote-risk: medium - Routing mistakes can hide key web surfaces or send users to broken pages.
 * @footnote-ethics: medium - The top-level route map affects access to transparency and self-hosting guidance.
 */

import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Hero from '@components/Hero';
import Invite from '@components/Invite';
import Services from '@components/Services';
import OpenAccountable from '@components/OpenAccountable';
import Footer from '@components/Footer';

const TracePage = lazy(() => import('@pages/TracePage'));
const SetupPage = lazy(() => import('@pages/SetupPage'));
const BlogListPage = lazy(() => import('@pages/BlogListPage'));
const BlogPostPage = lazy(() => import('@pages/BlogPostPage'));
const EmbedPage = lazy(() => import('@pages/EmbedPage'));
const AboutPage = lazy(() => import('@pages/AboutPage'));

const routeFallback = (
    <main
        id="main-content"
        className="interaction-status route-loading"
        role="status"
        aria-live="polite"
    >
        <div className="spinner" aria-hidden="true" />
        <p>Loading page...</p>
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
                    <main id="main-content">
                        <Hero />
                        <div className="section-container section-container--showcase">
                            <Services />
                        </div>
                        <div className="section-container section-container--principles">
                            <OpenAccountable />
                        </div>
                        <div className="section-container section-container--setup">
                            <Invite />
                        </div>
                        <Footer />
                    </main>
                }
            />
            <Route
                path="/setup"
                element={
                    <Suspense fallback={routeFallback}>
                        <SetupPage />
                    </Suspense>
                }
            />
            <Route
                path="/setup/"
                element={
                    <Suspense fallback={routeFallback}>
                        <SetupPage />
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
