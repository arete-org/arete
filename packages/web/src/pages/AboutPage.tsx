/**
 * @description: Renders the public About page with concrete expectations for
 * what Footnote shows, what trace records mean, and current project status.
 * @footnote-scope: web
 * @footnote-module: AboutPage
 * @footnote-risk: low - Copy errors can misstate product behavior and contribution readiness.
 * @footnote-ethics: medium - This page sets trust expectations and must avoid overclaiming verification guarantees.
 */

import Header from '@components/Header';
import Footer from '@components/Footer';
import StickySectionToc from '@components/StickySectionToc';
import { Link } from 'react-router-dom';

type AboutSectionId =
    | 'what-it-is'
    | 'what-you-see'
    | 'trace-page'
    | 'what-it-is-not'
    | 'open-source'
    | 'get-involved';

type SectionLink = {
    id: AboutSectionId;
    label: string;
};

const sectionLinks: SectionLink[] = [
    { id: 'what-it-is', label: 'What it is' },
    { id: 'what-you-see', label: 'What you see in a response' },
    { id: 'trace-page', label: 'The trace page' },
    { id: 'what-it-is-not', label: 'What it is not' },
    { id: 'open-source', label: 'Project status and self-hosting' },
    { id: 'get-involved', label: 'Get involved' },
];

const AboutPage = (): JSX.Element => (
    <>
        <Header />
        <main className="page-content" id="main-content">
            <header className="page-hero" aria-labelledby="about-title">
                <h1 id="about-title">AI that carries receipts.</h1>
                <p className="page-hero__summary">
                    Ask a question. Get an answer plus a record you can review.
                </p>
                <p>
                    Footnote is pre-1.0 and under active development. The core
                    provenance and trace flow is working today. We are still
                    expanding features and polish.
                </p>
            </header>

            <div className="page-layout">
                <StickySectionToc
                    ariaLabel="About sections"
                    sections={sectionLinks}
                />

                <article className="page-content__main">
                    <section
                        className="page-section"
                        id="what-it-is"
                        aria-labelledby="what-it-is-title"
                    >
                        <h2 id="what-it-is-title">What it is</h2>
                        <p>
                            Footnote is an AI framework focused on transparent
                            responses. It attaches review signals and provenance
                            metadata to answers so you can inspect how a
                            response was produced.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="what-you-see"
                        aria-labelledby="what-you-see-title"
                    >
                        <h2 id="what-you-see-title">
                            What you see in a response
                        </h2>
                        <p>
                            A response can include source links when available,
                            a safety tier, and a link to the trace page.
                        </p>
                        <p>
                            Those fields are not decoration. They are the review
                            surface: where evidence came from, what risk posture
                            the system reported, and where to inspect run
                            details.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="trace-page"
                        aria-labelledby="trace-page-title"
                    >
                        <h2 id="trace-page-title">The trace page</h2>
                        <p>
                            The trace page records model/runtime details,
                            workflow steps, and external-source usage when it
                            exists.
                        </p>
                        <p>
                            The trace does not prove an answer is correct. It
                            gives you a concrete record to verify and question.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="what-it-is-not"
                        aria-labelledby="what-it-is-not-title"
                    >
                        <h2 id="what-it-is-not-title">What it is not</h2>
                        <p>
                            Footnote is not a replacement for judgment, and it
                            is not a guaranteed fact-checking oracle. It helps
                            you review answer context. You still decide whether
                            the output is reliable enough for your use case.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="open-source"
                        aria-labelledby="open-source-title"
                    >
                        <h2 id="open-source-title">
                            Project status and self-hosting
                        </h2>
                        <p>
                            Footnote is open source. You can run it from the
                            repository and self-host it with your own provider
                            and infrastructure choices.
                        </p>
                        <p>
                            If you use hosted providers, review their privacy
                            and retention policies separately.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="get-involved"
                        aria-labelledby="get-involved-title"
                    >
                        <h2 id="get-involved-title">Get involved</h2>
                        <p>
                            Useful contributions include backend workflow
                            improvements, web trace UX, and docs that reduce
                            onboarding friction.
                        </p>
                        <p>
                            Start with the{' '}
                            <Link to="/onboarding">Onboarding page</Link> and
                            the project on{' '}
                            <a
                                href="https://github.com/footnote-ai/footnote"
                                target="_blank"
                                rel="noreferrer"
                            >
                                GitHub
                            </a>
                            .
                        </p>
                    </section>
                </article>
            </div>
        </main>
        <Footer />
    </>
);

export default AboutPage;
