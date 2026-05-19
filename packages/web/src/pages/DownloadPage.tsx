/**
 * @description: Presents the canonical container install path and supervised local-node architecture.
 * @footnote-scope: web
 * @footnote-module: DownloadPage
 * @footnote-risk: low - Incorrect install copy can misdirect operators without changing runtime behavior.
 * @footnote-ethics: low - Deployment guidance affects operator decisions and reliability expectations.
 */

import { useMemo, useState, type JSX } from 'react';
import Header from '@components/Header';
import Footer from '@components/Footer';

const DownloadPage = (): JSX.Element => {
    const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>(
        'idle'
    );

    const dockerCommand = useMemo(
        () =>
            [
                'docker run \\',
                '  --name footnote \\',
                '  -p 8080:3000 \\',
                '  --env-file .env \\',
                '  -v footnote-data:/data \\',
                '  ghcr.io/footnote-ai/footnote:latest',
            ].join('\n'),
        []
    );

    const handleCopy = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(dockerCommand);
            setCopyStatus('copied');
        } catch {
            setCopyStatus('error');
        }
    };

    return (
        <>
            <Header />
            <main className="page-content" id="main-content">
                <section className="page-hero">
                    <h1>Download</h1>
                    <p className="page-hero__summary">
                        Run Footnote as one server container that serves web,
                        owns provenance/traces, and supervises local Discord
                        persona nodes.
                    </p>
                    <p>Container image: `ghcr.io/footnote-ai/footnote`</p>
                    <pre>
                        <code>{dockerCommand}</code>
                    </pre>
                    <div className="cta-group">
                        <a
                            className="cta-button primary"
                            href="https://github.com/footnote-ai/footnote#run-with-docker"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Run with Docker
                        </a>
                        <button
                            className="cta-button secondary"
                            type="button"
                            onClick={handleCopy}
                        >
                            Copy the Docker command
                        </button>
                    </div>
                    <p>
                        {copyStatus === 'copied'
                            ? 'Copied.'
                            : copyStatus === 'error'
                              ? 'Copy failed.'
                              : ''}
                    </p>
                    <p>
                        Configure required environment variables and secrets
                        before starting the container.
                    </p>
                </section>
            </main>
            <Footer />
        </>
    );
};

export default DownloadPage;
