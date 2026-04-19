/**
 * @description: Renders the landing page hero content and primary calls to action for the web site.
 * @footnote-scope: web
 * @footnote-module: HeroSection
 * @footnote-risk: low - Hero regressions affect first impressions and CTA flow but do not break backend state.
 * @footnote-ethics: medium - The hero sets user expectations about privacy, honesty, and transparency.
 */

import { useState, type KeyboardEvent } from 'react';
import Header from './Header';
import AskMeAnything from './AskMeAnything';

// Hero banner introduces Footnote's tone and provides the primary calls to action.
const Hero = (): JSX.Element => {
    // No breadcrumbs on home page
    const breadcrumbItems: never[] = [];
    const [activeTab, setActiveTab] = useState<'try' | 'setup'>('try');
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
        }

        event.preventDefault();
        const currentTab =
            event.currentTarget.id === 'hero-tab-setup' ? 'setup' : 'try';
        const nextTab =
            event.key === 'ArrowRight'
                ? currentTab === 'try'
                    ? 'setup'
                    : 'try'
                : currentTab === 'setup'
                  ? 'try'
                  : 'setup';

        setActiveTab(nextTab);

        const nextTabElement = document.getElementById(
            nextTab === 'try' ? 'hero-tab-try' : 'hero-tab-setup'
        );
        if (nextTabElement instanceof HTMLButtonElement) {
            nextTabElement.focus();
        }
    };

    return (
        <section className="hero" aria-labelledby="hero-title">
            <Header breadcrumbItems={breadcrumbItems} />

            <div className="hero-copy">
                <h1 id="hero-title">
                    Ask a question. Get an answer with a trail.
                </h1>
                <p className="hero-copy__subtitle">
                    Footnote gives you a direct answer, then shows what shaped
                    it so you can see what shaped it, not just the final text.
                </p>
                <div className="hero-action-hub">
                    <div className="hero-action-tabs" role="tablist">
                        <button
                            id="hero-tab-try"
                            type="button"
                            role="tab"
                            aria-controls="hero-panel-try"
                            aria-selected={activeTab === 'try'}
                            tabIndex={activeTab === 'try' ? 0 : -1}
                            className={`hero-action-tab${activeTab === 'try' ? ' is-active' : ''}`}
                            onClick={() => setActiveTab('try')}
                            onKeyDown={handleKeyDown}
                        >
                            <span className="hero-action-tab__title">
                                Try it out
                            </span>
                            <span className="hero-action-tab__hint">
                                Ask a question right here
                            </span>
                        </button>
                        <button
                            id="hero-tab-setup"
                            type="button"
                            role="tab"
                            aria-controls="hero-panel-setup"
                            aria-selected={activeTab === 'setup'}
                            tabIndex={activeTab === 'setup' ? 0 : -1}
                            className={`hero-action-tab${activeTab === 'setup' ? ' is-active' : ''}`}
                            onClick={() => setActiveTab('setup')}
                            onKeyDown={handleKeyDown}
                        >
                            <span className="hero-action-tab__title">
                                Set it up
                            </span>
                            <span className="hero-action-tab__hint">
                                Minimal self-host quickstart
                            </span>
                        </button>
                    </div>
                    <div className="hero-action-panel">
                        <div
                            id="hero-panel-try"
                            role="tabpanel"
                            aria-labelledby="hero-tab-try"
                            hidden={activeTab !== 'try'}
                        >
                            <AskMeAnything />
                        </div>
                        <div
                            id="hero-panel-setup"
                            role="tabpanel"
                            aria-labelledby="hero-tab-setup"
                            hidden={activeTab !== 'setup'}
                        >
                            <section
                                className="setup-quickstart"
                                aria-labelledby="setup-quickstart-title"
                            >
                                <h3 id="setup-quickstart-title">Quick setup</h3>
                                <ol>
                                    <li>
                                        <code>pnpm install</code>
                                    </li>
                                    <li>
                                        <code>cp .env.example .env</code>
                                    </li>
                                    <li>
                                        <code>pnpm dev</code>
                                    </li>
                                </ol>
                                <a href="/invite/" className="inline-cta">
                                    Full setup guide
                                    <span aria-hidden="true">↗</span>
                                </a>
                            </section>
                        </div>
                    </div>
                </div>

                <div className="intro-card" aria-labelledby="intro-card-title">
                    <div className="intro-card-background" aria-hidden="true">
                        {/* Symbolic constellation representing Footnote's ethical framework. */}
                        <svg
                            viewBox="0 0 320 120"
                            role="presentation"
                            focusable="false"
                        >
                            <g className="intro-card-constellation">
                                <circle cx="30" cy="60" r="4" />
                                <circle cx="110" cy="30" r="3" />
                                <circle cx="200" cy="65" r="4" />
                                <circle cx="280" cy="40" r="3" />
                                <path d="M30 60 L110 30 L200 65 L280 40" />
                            </g>
                        </svg>
                    </div>
                    <div className="intro-card-content">
                        <div className="intro-card-logo">
                            <img
                                src="/assets/logo.jpg"
                                alt="Footnote logo - A circle with 5 even-spaced solid color wedges. From top-left, clockwise: Teal, rose, amber, copper, emerald."
                                className="intro-card-logo-image"
                            />
                        </div>
                        <div className="intro-card-text">
                            <h2 id="intro-card-title">
                                What you get after asking
                            </h2>
                            <p>
                                The response is not just text in a chat box. You
                                can inspect what happened.
                            </p>
                            <ul className="intro-card-list">
                                <li>A direct answer.</li>
                                <li>Source links when web sources are used.</li>
                                <li>
                                    Provenance details with safety and
                                    confidence signals.
                                </li>
                                <li>
                                    A trace link so you can open the full run.
                                </li>
                            </ul>
                            <p>
                                If you want full control, use the setup tab and
                                run Footnote in your own environment.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default Hero;
