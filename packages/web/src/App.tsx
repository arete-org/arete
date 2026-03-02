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
import InvitePage from '@pages/InvitePage';
import BlogListPage from '@pages/BlogListPage';
import BlogPostPage from '@pages/BlogPostPage';
import EmbedPage from '@pages/EmbedPage';

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
                        <div className="section-container">
                            <Services />
                        </div>
                        <div className="section-container">
                            <OpenAccountable />
                        </div>
                        <div className="section-container">
                            <Invite />
                        </div>
                        <Footer />
                    </main>
                }
            />
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/invite/" element={<InvitePage />} />
            <Route path="/embed" element={<EmbedPage />} />
            <Route path="/blog" element={<BlogListPage />} />
            <Route path="/blog/" element={<BlogListPage />} />
            <Route path="/blog/:number" element={<BlogPostPage />} />
            <Route path="/api/traces/:responseId" element={<TracePage />} />
        </Routes>
    </div>
);

export default App;
