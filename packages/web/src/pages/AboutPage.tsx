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
                            This is also about control. Keeping your data
                            private when you need to. Choosing how it runs. And
                            being able to change things later without the whole
                            thing falling apart.
                        </p>
                        <p>
                            A lot of tools make it easy to start and hard to
                            leave. We are trying to avoid that. You should not
                            get stuck with one company just because it was the
                            default. If you want to use a different kind of AI
                            later, you should not have to rebuild everything.
                            And if you want to run it yourself, that should be
                            doable without a weekend of frustration.
                        </p>
                        <p>
                            And trust is not about how smooth the writing is. A
                            clean, well-written answer can still be wrong, or
                            leave out something important. Footnote tries to
                            give you a way to check it: where claims came from,
                            what the system relied on, and when extra caution is
                            worth it. If it is doing its job, you can dig in
                            when you care and skim when you do not.
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
