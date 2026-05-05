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
        <main className="page-content" id="main-content">
            <section className="page-hero">
                <h1>Download</h1>
                <p className="page-hero__summary">
                    Packaged installers are planned, but not available yet.
                </p>
                <p>For now, see GitHub for self-hosting instructions:</p>
                <div className="cta-group">
                    <a
                        className="cta-button primary"
                        href="https://github.com/footnote-ai/footnote#quickstart"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Quickstart{' '}
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            width="16"
                            height="16"
                            style={{ marginLeft: '0.5em' }}
                        >
                            <path
                                fill="currentColor"
                                d="M12 .5A11.5 11.5 0 0 0 .5 12.2c0 5.23 3.39 9.68 8.1 11.25.6.12.82-.27.82-.58v-2.25c-3.29.73-3.98-1.63-3.98-1.63-.54-1.41-1.33-1.79-1.33-1.79-1.08-.76.08-.75.08-.75 1.2.09 1.83 1.26 1.83 1.26 1.06 1.87 2.79 1.33 3.47 1.01.11-.79.42-1.33.76-1.64-2.62-.31-5.37-1.35-5.37-6a4.76 4.76 0 0 1 1.23-3.32 4.43 4.43 0 0 1 .12-3.27s1.01-.33 3.3 1.27a11.19 11.19 0 0 1 6 0c2.29-1.6 3.3-1.27 3.3-1.27.45 1.03.5 2.22.12 3.27a4.76 4.76 0 0 1 1.23 3.32c0 4.66-2.76 5.68-5.39 5.98.43.38.81 1.11.81 2.25v3.34c0 .33.22.71.83.58a11.72 11.72 0 0 0 8.09-11.25A11.5 11.5 0 0 0 12 .5Z"
                            />
                        </svg>
                    </a>
                </div>
            </section>
        </main>
        <Footer />
    </>
);

export default DownloadPage;
