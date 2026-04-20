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
    { id: 'why-footnote-exists', label: 'Why Footnote exists' },
    { id: 'reading-a-response', label: 'Reading a response' },
    { id: 'what-a-trace-is', label: 'What a trace is' },
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

const responseDetails = [
    'the answer itself',
    'source links',
    'confidence and safety notes',
    'tradeoffs or constraints when they matter',
    'a trace page with more detail about the run',
] as const;

const AboutPage = (): JSX.Element => (
    <>
        <Header breadcrumbItems={breadcrumbItems} />
        <main className="about-page" id="main-content">
            <section className="about-hero" aria-labelledby="about-title">
                <p className="about-eyebrow">About</p>
                <h1 id="about-title">See what is behind an answer</h1>
                <p className="about-summary">
                    Footnote is an AI assistant that helps you see what is
                    behind an answer.
                </p>
                <p>
                    It gives you a response with receipts: source links,
                    confidence and safety notes, and a trace page for digging
                    deeper.
                </p>
                <p>
                    This page explains why the project exists, what Footnote
                    shows you, and where to go next if you want to run it or
                    contribute to it.
                </p>
                <nav className="about-jump-nav" aria-label="About sections">
                    <ul className="about-jump-list">
                        {sectionLinks.map((link) => (
                            <li key={link.id}>
                                <a href={`#${link.id}`}>{link.label}</a>
                            </li>
                        ))}
                    </ul>
                </nav>
            </section>

            <section
                className="about-section"
                id="why-footnote-exists"
                aria-labelledby="why-footnote-exists-title"
            >
                <h2 id="why-footnote-exists-title">Why Footnote exists</h2>
                <p>
                    AI answers can sound more certain than they are. Footnote is
                    built around a different habit: keep the answer connected to
                    the context around it.
                </p>
                <p>
                    The goal is not to make every answer automatically correct.
                    The goal is to give people more to inspect before they
                    decide what to do with the answer.
                </p>
            </section>

            <section
                className="about-section"
                id="reading-a-response"
                aria-labelledby="reading-a-response-title"
            >
                <h2 id="reading-a-response-title">Reading a response</h2>
                <p>
                    A Footnote response can include a few layers of context
                    alongside the answer.
                </p>
                <ul className="about-list">
                    {responseDetails.map((detail) => (
                        <li key={detail}>{detail}</li>
                    ))}
                </ul>
                <p>
                    The point is simple: if something feels uncertain, you
                    should have more than a polished paragraph to work from.
                </p>
            </section>

            <section
                className="about-section"
                id="what-a-trace-is"
                aria-labelledby="what-a-trace-is-title"
            >
                <h2 id="what-a-trace-is-title">What a trace is</h2>
                <p>
                    A trace is the receipt for a response. It collects the
                    details Footnote recorded while answering: sources,
                    model/runtime information, safety notes, and workflow
                    details when they apply.
                </p>
                <p>
                    A trace does not prove the answer is correct. It gives you
                    something to inspect.
                </p>
            </section>

            <section
                className="about-section"
                id="open-source-and-self-hosting"
                aria-labelledby="open-source-and-self-hosting-title"
            >
                <h2 id="open-source-and-self-hosting-title">
                    Open source and self-hosting
                </h2>
                <p>
                    Footnote is open source and built to run outside the hosted
                    demo. You can try the browser demo, run your own copy from
                    the repo, or self-host it with your own setup.
                </p>
                <p>
                    That does not remove every external dependency by itself. If
                    you use hosted model providers, their privacy and retention
                    rules still matter.
                </p>
            </section>

            <section
                className="about-section"
                id="what-we-are-careful-about"
                aria-labelledby="what-we-are-careful-about-title"
            >
                <h2 id="what-we-are-careful-about-title">
                    What we are careful about
                </h2>
                <ul className="about-list">
                    <li>Inspectable does not mean always correct.</li>
                    <li>Review signals do not guarantee answer quality.</li>
                    <li>
                        Self-hosting does not automatically put external model
                        providers under your control.
                    </li>
                    <li>
                        TrustGraph stays advisory unless visible product output
                        says otherwise.
                    </li>
                    <li>
                        Steerability should not be overclaimed before there are
                        clearer user-facing controls.
                    </li>
                </ul>
            </section>

            <section
                className="about-section"
                id="developers"
                aria-labelledby="developers-title"
            >
                <h2 id="developers-title">Developers and contributors</h2>
                <p>
                    If you want the architecture details or want to work in the
                    repo, start with these.
                </p>
                <ul className="about-links">
                    {developerLinks.map((link) => (
                        <li key={link.href}>
                            <a
                                href={link.href}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {link.label} <span aria-hidden="true">↗</span>
                            </a>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
        <Footer />
    </>
);

export default AboutPage;
