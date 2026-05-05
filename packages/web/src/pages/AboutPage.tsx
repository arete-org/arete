/**
 * @description: Renders the public About page for Footnote with a plain
 * explanation of what the project is, what it shows, and where to go next.
 * @footnote-scope: web
 * @footnote-module: AboutPage
 * @footnote-risk: low - Inaccurate copy can misstate what the product shows or overstate project guarantees.
 * @footnote-ethics: medium - This page shapes user expectations about transparency, review, and self-hosting limits.
 */

import Header from '@components/Header';
import Footer from '@components/Footer';

type AboutSectionId =
    | 'why-footnote-exists'
    | 'reading-a-response'
    | 'what-a-trace-is'
    | 'open-source-and-self-hosting'
    | 'what-we-are-careful-about'
    | 'developers';

type SectionLink = {
    id: AboutSectionId;
    label: string;
};

type DeveloperLink = {
    href: string;
    label: string;
};

const breadcrumbItems = [{ label: 'About' }];

const sectionLinks: SectionLink[] = [
    { id: 'why-footnote-exists', label: 'A better way to read AI' },
    { id: 'reading-a-response', label: 'Inside a response' },
    { id: 'what-a-trace-is', label: 'The record' },
    {
        id: 'open-source-and-self-hosting',
        label: 'Open source and self-hosting',
    },
    {
        id: 'what-we-are-careful-about',
        label: 'What we are careful about',
    },
    { id: 'developers', label: 'Developers and contributors' },
];

const repoBaseUrl = 'https://github.com/footnote-ai/footnote/blob/main';

const developerLinks: DeveloperLink[] = [
    {
        href: `${repoBaseUrl}/README.md`,
        label: 'README',
    },
    {
        href: `${repoBaseUrl}/docs/README.md`,
        label: 'Docs',
    },
    {
        href: `${repoBaseUrl}/docs/architecture/README.md`,
        label: 'Architecture docs',
    },
    {
        href: `${repoBaseUrl}/AGENTS.md`,
        label: 'AGENTS.md',
    },
    {
        href: `${repoBaseUrl}/docs/ai/README.md`,
        label: 'AI assistance guide',
    },
    {
        href: `${repoBaseUrl}/deploy/README.md`,
        label: 'Deploy docs',
    },
];

const AboutPage = (): JSX.Element => (
    <>
        <Header breadcrumbItems={breadcrumbItems} />
        <main className="page-content" id="main-content">
            <header className="page-hero" aria-labelledby="about-title">
                <h1 id="about-title">AI that carries receipts.</h1>
                <p className="page-hero__summary">
                    Footnote is an AI framework that tries to show its work.
                </p>
                <p>
                    Ask a question and Footnote gives you a response with
                    receipts: source links, confidence and safety notes, and a
                    trace page for digging deeper.
                </p>
            </header>

            <div className="page-layout">
                <aside className="page-toc">
                    <nav className="onboarding-toc" aria-label="About sections">
                        <p className="onboarding-toc__title">Index</p>
                        <ul className="onboarding-toc__list">
                            {sectionLinks.map((link) => (
                                <li key={link.id}>
                                    <a href={`#${link.id}`}>{link.label}</a>
                                </li>
                            ))}
                        </ul>
                    </nav>
                </aside>

                <article className="page-content">
                    <section
                        className="page-section"
                        id="why-footnote-exists"
                        aria-labelledby="why-footnote-exists-title"
                    >
                        <h2 id="why-footnote-exists-title">
                            A better way to read AI
                        </h2>
                        <p>
                            AI can be impressively fluent and still leave you
                            guessing about where an answer came from. Footnote
                            is built to make that gap visible. It keeps answers
                            tied to the context behind them, so people can see
                            what an answer is standing on.
                        </p>
                        <p>
                            Footnote does not try to pretend every answer is
                            perfect. It helps people slow down, look at what the
                            answer is based on, and decide for themselves
                            whether it feels solid enough to trust. It is part
                            of a bigger question about steerability: how to give
                            people more control over the direction of an answer,
                            with more visibility into how it was produced.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="reading-a-response"
                        aria-labelledby="reading-a-response-title"
                    >
                        <h2 id="reading-a-response-title">Inside a response</h2>
                        <p>
                            Footnote tries to give you more than the answer on
                            its own. Alongside a response, you may see source
                            links, notes about confidence or safety, tradeoffs
                            or constraints when they matter, and a trace page
                            with more detail about how it came together.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="what-a-trace-is"
                        aria-labelledby="what-a-trace-is-title"
                    >
                        <h2 id="what-a-trace-is-title">The record</h2>
                        <p>
                            A trace keeps the trail Footnote followed while
                            answering: sources, model and runtime details,
                            safety notes, and workflow steps when they matter.
                        </p>
                        <p>
                            It does not prove the answer is right. It gives you
                            a record you can open, follow, and question when you
                            want to understand how the response came together.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="open-source-and-self-hosting"
                        aria-labelledby="open-source-and-self-hosting-title"
                    >
                        <h2 id="open-source-and-self-hosting-title">
                            Open source and self-hosting
                        </h2>
                        <p>
                            Footnote is open source and built to run outside the
                            hosted demo. You can try the browser demo, run your
                            own copy from the repo, or self-host it with your
                            own setup.
                        </p>
                        <p>
                            That does not remove every external dependency by
                            itself. If you use hosted model providers, their
                            privacy and retention rules still matter.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="what-we-are-careful-about"
                        aria-labelledby="what-we-are-careful-about-title"
                    >
                        <h2 id="what-we-are-careful-about-title">
                            What we are careful about
                        </h2>
                        <ul className="page-list">
                            <li>Inspectable does not mean always correct.</li>
                            <li>
                                Review signals do not guarantee answer quality.
                            </li>
                            <li>
                                Self-hosting does not automatically put external
                                model providers under your control.
                            </li>
                            <li>
                                TrustGraph stays advisory unless visible product
                                output says otherwise.
                            </li>
                            <li>
                                Steerability should not be overclaimed before
                                there are clearer user-facing controls.
                            </li>
                        </ul>
                    </section>

                    <section
                        className="page-section"
                        id="developers"
                        aria-labelledby="developers-title"
                    >
                        <h2 id="developers-title">
                            Developers and contributors
                        </h2>
                        <p>
                            If you want the architecture details or want to work
                            in the repo, start with these.
                        </p>
                        <p>
                            For current workflow and trace rendering
                            architecture, start with the{' '}
                            <a href="/onboarding">
                                contributor onboarding page
                            </a>
                            .
                        </p>
                        <ul className="page-list">
                            {developerLinks.map((link) => (
                                <li key={link.href}>
                                    <a
                                        href={link.href}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {link.label}{' '}
                                        <span aria-hidden="true">↗</span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </section>
                </article>
            </div>
        </main>
        <Footer />
    </>
);

export default AboutPage;
