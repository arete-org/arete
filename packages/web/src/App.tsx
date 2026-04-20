/**
 * @description: Defines the web app route tree and stitches together the landing page and standalone pages.
 * @footnote-scope: web
 * @footnote-module: WebAppRoutes
 * @footnote-risk: medium - Routing mistakes can hide key web surfaces or send users to broken pages.
 * @footnote-ethics: medium - The top-level route map affects access to transparency and self-hosting guidance.
 */

import { Routes, Route } from 'react-router-dom';
import Hero from '@components/Hero';
import Invite from '@components/Invite';
import Services from '@components/Services';
import OpenAccountable from '@components/OpenAccountable';
import Footer from '@components/Footer';
import TracePage from '@pages/TracePage';
import SetupPage from '@pages/SetupPage';
import BlogListPage from '@pages/BlogListPage';
import BlogPostPage from '@pages/BlogPostPage';
import EmbedPage from '@pages/EmbedPage';
import AboutPage from '@pages/AboutPage';

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
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/setup/" element={<SetupPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/about/" element={<AboutPage />} />
            <Route path="/embed" element={<EmbedPage />} />
            <Route path="/blog" element={<BlogListPage />} />
            <Route path="/blog/" element={<BlogListPage />} />
            <Route path="/blog/:number" element={<BlogPostPage />} />
            <Route path="/traces/:responseId" element={<TracePage />} />
            <Route path="/api/traces/:responseId" element={<TracePage />} />
        </Routes>
    </div>
);

export default App;
