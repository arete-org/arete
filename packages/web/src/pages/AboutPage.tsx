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
    | 'the-mission'
    | 'reading-a-response'
    | 'project-state'
    | 'contribute';

type SectionLink = {
    id: AboutSectionId;
    label: string;
};

const sectionLinks: SectionLink[] = [
    { id: 'the-mission', label: 'The mission' },
    { id: 'reading-a-response', label: 'Reading a response' },
    { id: 'project-state', label: 'Project state' },
    { id: 'contribute', label: 'Contribute' },
];

const AboutPage = (): JSX.Element => (
    <>
        <Header />
        <main className="page-content" id="main-content">
            <header className="page-hero" aria-labelledby="about-title">
                <h1 id="about-title">AI that carries receipts.</h1>
                <p className="page-hero__summary">
                    Footnote is an attempt to build something better.
                </p>
                <p>
                    Most AI answers show up fast, confident, and polished, and
                    you are still left guessing what is real. That is not a
                    fluke. The industry gets rewarded for speed, lock-in, and
                    persuasion, not for being checkable. Footnote gives you
                    receipts: sources you can open, notes about uncertainty and
                    safety when they matter, and a trace you can follow when you
                    want the full story.
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
                        id="the-mission"
                        aria-labelledby="the-mission-title"
                    >
                        <h2 id="the-mission-title">The mission</h2>
                        <p>
                            Footnote is for people who do not want to trust
                            vibes. If an answer cannot show what it is leaning
                            on, you are stuck taking it on faith. We are
                            building responses you can interrogate: where claims
                            came from, what shaped the answer, and what happened
                            on the way there.
                        </p>
                        <p>
                            This is also about control over data, defaults, and
                            dependencies. Your provider should not be a trap.
                            Your model choice should not mean rewriting the
                            whole system. Self-hosting should not be a weekend
                            project. If you want stricter privacy boundaries,
                            different infrastructure, lower costs, or a setup
                            that better matches your values, that should be a
                            practical choice.
                        </p>
                        <p>
                            Trust is not a tone. It is a paper trail. If
                            Footnote is doing its job, you end up with more
                            leverage: more places to look, more ways to
                            question, and fewer reasons to accept a confident
                            paragraph at face value.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="reading-a-response"
                        aria-labelledby="reading-a-response-title"
                    >
                        <h2 id="reading-a-response-title">
                            Reading a response
                        </h2>
                        <p>
                            A Footnote response is not just the paragraph. It
                            comes with handles: small, visible clues you can
                            grab when you want to verify something, slow down,
                            or dig deeper.
                        </p>
                        <div
                            className="card"
                            aria-label="Response diagram placeholder"
                        >
                            <p>
                                <strong>Placeholder:</strong> labeled diagram of
                                one response, including the answer, sources,
                                safety label, TRACE panel, and trace link.
                            </p>
                        </div>
                        <p>
                            Sources are the obvious one. Open them and see what
                            a claim is anchored to. Safety notes are there for
                            the moments when &ldquo;sounds fine&rdquo; is not
                            good enough. TRACE is the quick snapshot: what ran,
                            what mattered, what shaped the answer. The trace
                            link opens the longer record.
                        </p>
                        <p>
                            Open the trace page and you can look at the fuller
                            trail: what model ran, which steps happened, what
                            tools were used, and what supporting material showed
                            up along the way. None of this guarantees the answer
                            is correct. That is the point. It gives you
                            something concrete to inspect instead of a smooth
                            answer with no way to audit it.
                        </p>
                        <div
                            className="card"
                            aria-label="Trace diagram placeholder"
                        >
                            <p>
                                <strong>Placeholder:</strong> one or more
                                labeled snippets of the trace page, showing the
                                main sections worth explaining.
                            </p>
                        </div>
                    </section>

                    <section
                        className="page-section"
                        id="project-state"
                        aria-labelledby="project-state-title"
                    >
                        <h2 id="project-state-title">Project state</h2>
                        <p>
                            Footnote is open source, and it is early. The core
                            idea is here. The hard part now is making it
                            sturdier, clearer, and genuinely usable, not just
                            impressive in a demo.
                        </p>
                        <p>
                            You can run it from the repository and self-host it
                            on your own infrastructure, with the model and
                            provider choices you prefer. If you use hosted
                            providers, their privacy and retention policies
                            still apply. Footnote cannot hand-wave that away, so
                            this page should not pretend otherwise.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="contribute"
                        aria-labelledby="contribute-title"
                    >
                        <h2 id="contribute-title">Contribute</h2>
                        <p>
                            If this lines up with the questions you already have
                            about AI, jump in. There is real work across the
                            stack: backend, frontend, UX, docs, diagrams, and
                            the unglamorous job of making complicated things
                            understandable.
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
