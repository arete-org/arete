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
                    Most AI answers show up fast, confident, and polished, but
                    you&apos;re left guessing what&apos;s real. That&apos;s the
                    predictable result of the incentives: the industry is
                    rewarded for speed and persuasion, not for making answers
                    easy to verify.
                </p>

                <p>
                    Footnote isn&apos;t trying to be the flashiest AI. We care
                    about giving you receipts: clear links to sources, notes
                    about uncertainty and safety when they matter, and a paper
                    trail you can follow when you want the full story.
                </p>

                <p>
                    We believe AI that serves real people starts with being{' '}
                    <strong>accessible</strong>, <strong>open</strong>, and{' '}
                    <strong>honest</strong>.
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
                            Footnote is meant to make answers easier to understand
                            and check. You shouldn&apos;t have to guess where
                            something came from.
                        </p>

                        <p>
                            It's also about control—keeping your data private, 
                            choosing how the system runs, and being able to change 
                            things later without everything falling apart.
                        </p>

                        <p>
                            Choice matters, so we try not to make it painful. Footnote 
                            is designed to let you switch models or providers without 
                            reworking the whole system. And if you want to{" "}
                            <a
                                href="https://github.com/footnote-ai/footnote#quickstart"
                                target="_blank"
                                rel="noreferrer"
                            >
                                run it yourself
                            </a>
                            , it should be doable without a weekend of frustration.
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
                            A Footnote response comes with visible clues that can
                            help when you want to slow down and dig deeper.
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
                            Sources let you see what a claim is anchored to.
                            Safety notes are there for the moments when 
                            &ldquo;sounds fine&rdquo; is not good enough.
                            TRACE is a snapshot of the response's posture.
                            The trace link opens the longer, more detailed record.
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
                        <p>
                            The trace page is the paper trail: which model ran,
                            what steps happened, what tools were used, and what
                            supporting material showed up along the way. It's not 
                            proof, but a record you can open and verify for yourself.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="project-state"
                        aria-labelledby="project-state-title"
                    >
                        <h2 id="project-state-title">Project state</h2>
                        <p>
                            Footnote is open source and in early development.
                            The core idea is here, but the hard part now is
                            making it sturdy, clear, and genuinely usable.
                        </p>
                        <p>
                            You can run it from the repository and self-host it
                            on your own infrastructure, with the model and
                            provider choices you prefer (e.g., OpenAI,
                            Anthropic, Google, or others). If you use hosted
                            providers, their privacy and retention policies
                            still apply.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="contribute"
                        aria-labelledby="contribute-title"
                    >
                        <h2 id="contribute-title">Contribute</h2>
                        <p>
                            If this lines up with the concerns you already have
                            about AI, we'd love to have your help in realizing Footnote. 
                            There is real work to do across the frontend, backend, UX, docs, 
                            diagrams—and making it legible to normal people (including grandma).
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
