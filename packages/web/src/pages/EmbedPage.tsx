/**
 * @description: Hosts the embeddable Footnote page and coordinates iframe sizing behavior for external sites.
 * @footnote-scope: web
 * @footnote-module: EmbedPage
 * @footnote-risk: medium - Embed sizing or messaging bugs can break integrations and hide the interactive surface.
 * @footnote-ethics: high - The embed experience affects how external users encounter prompts, responses, and provenance cues.
 */

import { useEffect, useRef } from 'react';
import Header from '@components/Header';
import AskMeAnything from '@components/AskMeAnything';
import {
    createEmbedHeightMessenger,
    EMBED_LAYOUT_CHANGE_EVENT,
} from '../utils/embedHeight';

/**
 * EmbedPage component provides a minimal embeddable version of Footnote
 * that includes the header, title/subtitle, intro section, and AskMeAnything.
 * Designed for iframe embedding in external sites.
 * Automatically communicates height to parent window to eliminate scrollbars.
 */
const EmbedPage = (): JSX.Element => {
    // No breadcrumbs for embed page
    const breadcrumbItems: never[] = [];
    const containerRef = useRef<HTMLElement | null>(null);

    // Disable scrolling on the embed page itself and keep the host iframe sized to the content.
    useEffect(() => {
        if (window.parent !== window) {
            const style = document.createElement('style');
            style.textContent = `
        html, body {
          overflow: hidden !important;
          height: auto !important;
        }
      `;
            document.head.appendChild(style);
        }

        const messenger = createEmbedHeightMessenger({
            root: containerRef.current,
        });
        const scheduleHeightPost = (): void => {
            messenger.schedulePostHeight();
        };

        messenger.postHeight();

        const resizeObserver = new ResizeObserver(() => {
            scheduleHeightPost();
        });
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
        }
        resizeObserver.observe(document.body);
        resizeObserver.observe(document.documentElement);

        window.addEventListener('resize', scheduleHeightPost);
        window.addEventListener('load', scheduleHeightPost);
        window.addEventListener(EMBED_LAYOUT_CHANGE_EVENT, scheduleHeightPost);

        const fontSet = document.fonts;
        const fontReadyPromise = fontSet?.ready;
        fontReadyPromise
            ?.then(() => {
                scheduleHeightPost();
            })
            .catch(() => {
                scheduleHeightPost();
            });

        const settleTimeouts = [
            window.setTimeout(() => {
                messenger.postHeight();
            }, 0),
            window.setTimeout(() => {
                scheduleHeightPost();
            }, 100),
            window.setTimeout(() => {
                scheduleHeightPost();
            }, 300),
        ];

        return () => {
            resizeObserver.disconnect();
            window.removeEventListener('resize', scheduleHeightPost);
            window.removeEventListener('load', scheduleHeightPost);
            window.removeEventListener(
                EMBED_LAYOUT_CHANGE_EVENT,
                scheduleHeightPost
            );
            settleTimeouts.forEach((timeoutId) =>
                window.clearTimeout(timeoutId)
            );
            messenger.dispose();
        };
    }, []);

    return (
        <section
            ref={containerRef}
            className="hero"
            aria-labelledby="hero-title"
        >
            <Header breadcrumbItems={breadcrumbItems} />

            <div className="hero-copy">
                <h1 id="hero-title">AI you can inspect and steer.</h1>
                <p className="hero-copy__subtitle">
                    A transparency-first framework for people who want more than
                    a black-box answer.
                </p>

                <AskMeAnything />

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
                            <h2 id="intro-card-title">Footnote, at a glance</h2>
                            <p>
                                Footnote pairs model output with inspectable
                                metadata, including confidence, sources,
                                trade-offs, and applied constraints. Run it
                                locally, self-host it, or bring it into Discord
                                while keeping human oversight in the loop.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default EmbedPage;
