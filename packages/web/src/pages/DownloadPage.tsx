/**
 * @description: Provides a minimal status page for planned packaged downloads and current install paths.
 * @footnote-scope: web
 * @footnote-module: DownloadPage
 * @footnote-risk: low - Copy/link errors can misdirect users but do not impact runtime behavior.
 * @footnote-ethics: low - This page sets expectations for installation options and source-of-truth docs.
 */

import Header from '@components/Header';
import Footer from '@components/Footer';

const breadcrumbItems = [{ label: 'Download' }];

const DownloadPage = (): JSX.Element => (
    <>
        <Header breadcrumbItems={breadcrumbItems} />
        <main className="site-section" id="main-content">
            <article className="card" aria-labelledby="download-title">
                <h1 id="download-title">Download</h1>
                <p>Packaged installers are planned, but not available yet.</p>
                <p>
                    For now, GitHub is the source of truth for developer setup
                    and self-hosted installation.
                </p>
                <div className="cta-group">
                    <a
                        className="cta-button primary"
                        href="https://github.com/footnote-ai/footnote"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Open Source on GitHub <span aria-hidden="true">↗</span>
                    </a>
                    <a
                        className="cta-button secondary"
                        href="https://github.com/footnote-ai/footnote/blob/main/README.md"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Read Setup Docs <span aria-hidden="true">↗</span>
                    </a>
                </div>
            </article>
        </main>
        <Footer />
    </>
);

export default DownloadPage;
