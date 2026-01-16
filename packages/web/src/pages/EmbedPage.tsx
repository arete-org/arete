import { useEffect, useRef } from 'react';
import Header from '@components/Header';
import AskMeAnything from '@components/AskMeAnything';

/**
 * EmbedPage component provides a minimal embeddable version of ARETE
 * that includes the header, title/subtitle, "I'm Arí" section, and AskMeAnything.
 * Designed for iframe embedding in external sites.
 * Automatically communicates height to parent window to eliminate scrollbars.
 */
const EmbedPage = (): JSX.Element => {
    // No breadcrumbs for embed page
    const breadcrumbItems: never[] = [];
    const containerRef = useRef<HTMLElement | null>(null);

    // Disable scrolling on embed page and send height to parent
    useEffect(() => {
        // Disable scrolling on the embed page itself when in an iframe
        if (window.parent !== window) {
            // Add CSS to disable scrolling
            const style = document.createElement('style');
            style.textContent = `
        html, body {
          overflow: hidden !important;
          height: auto !important;
        }
      `;
            document.head.appendChild(style);
        }

        const sendHeight = () => {
            // Only send if we're in an iframe
            if (window.parent === window) return;

            // Get the full document height including margins and padding
            const height = Math.max(
                document.documentElement.scrollHeight,
                document.documentElement.offsetHeight,
                document.body.scrollHeight,
                document.body.offsetHeight,
                document.body.clientHeight
            );

            // Debug logging (can be removed in production)
            if (process.env.NODE_ENV === 'development') {
                console.log('[ARETE Embed] Sending height:', height);
            }

            window.parent.postMessage(
                { type: 'arete-embed-height', height },
                '*' // Allow any origin - parent should validate origin for security
            );
        };

        // Send initial height after a short delay to ensure content is rendered
        const initialTimeout = setTimeout(sendHeight, 100);

        // Use ResizeObserver to detect content changes on body
        const resizeObserver = new ResizeObserver(() => {
            sendHeight();
        });

        // Observe both body and documentElement to catch all changes
        resizeObserver.observe(document.body);
        if (document.documentElement) {
            resizeObserver.observe(document.documentElement);
        }

        // Also send height on window resize (for responsive changes)
        window.addEventListener('resize', sendHeight);

        // Send height periodically as fallback (e.g., when animations complete)
        const interval = setInterval(sendHeight, 500);

        // Also send height after mutations (e.g., when AskMeAnything updates)
        const mutationObserver = new MutationObserver(() => {
            sendHeight();
        });

        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class'],
        });

        return () => {
            clearTimeout(initialTimeout);
            resizeObserver.disconnect();
            mutationObserver.disconnect();
            window.removeEventListener('resize', sendHeight);
            clearInterval(interval);
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
                <h1 id="hero-title">Mindful and honest AI.</h1>
                <p className="hero-copy__subtitle">
                    Ethics-first, private, and easy to run yourself.
                </p>

                <div className="arete" aria-labelledby="arete-title">
                    <div className="arete-background" aria-hidden="true">
                        {/* Symbolic constellation representing ARETE's ethical framework. */}
                        <svg
                            viewBox="0 0 320 120"
                            role="presentation"
                            focusable="false"
                        >
                            <g className="arete-constellation">
                                <circle cx="30" cy="60" r="4" />
                                <circle cx="110" cy="30" r="3" />
                                <circle cx="200" cy="65" r="4" />
                                <circle cx="280" cy="40" r="3" />
                                <path d="M30 60 L110 30 L200 65 L280 40" />
                            </g>
                        </svg>
                    </div>
                    <div className="arete-content">
                        <div className="arete-logo">
                            <img
                                src="/assets/logo.jpg"
                                alt="ARETE logo - a compass-like design with a capital A"
                                className="arete-logo-image"
                            />
                        </div>
                        <div className="arete-text">
                            <h2 id="arete-title">I'm Arí,</h2>
                            <p>
                                I'm an AI built for clarity and care, not speed
                                or persuasion. I explain how I think, and
                                clearly show what I know and what I don't. You
                                can host me yourself, invite me to Discord, and
                                see how I work.
                            </p>
                        </div>
                    </div>
                </div>

                <AskMeAnything />
            </div>
        </section>
    );
};

export default EmbedPage;
