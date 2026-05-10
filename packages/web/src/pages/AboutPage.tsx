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
                    Footnote is a project about making AI easier to question.
                </p>
                <p>
                    A lot of people have had the same experience with AI:
                    something answers quickly, sounds sure of itself, and still
                    leaves you with no clear way to tell what to trust. Footnote
                    is one attempt to build something better.
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
                            Footnote is not trying to make AI feel smoother,
                            faster, or more impressive than it already does. It
                            is trying to make it less of a black box. That
                            starts with answers you can examine, but it does not
                            end there.
                        </p>
                        <p>
                            The project is also about privacy, ownership, and
                            choice. People should have more say in how a system
                            is run, where their data goes, which model or
                            provider they rely on, and what trade-offs they are
                            being asked to accept. If a person cares about
                            hosting something themselves, using a different
                            provider, or avoiding a setup that feels wrong to
                            them, that should be a practical option.
                        </p>
                        <p>
                            Under all of that is a simple idea: trust should be
                            earned. Not by tone, not by polish, and not by
                            pretending the system is wiser than it is. If
                            Footnote is doing its job, it should leave people
                            with more room to inspect, question, and choose.
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
                            The easiest way to explain Footnote is to show what
                            sits around an answer. The response itself is only
                            one part. Around it, you may see sources, a safety
                            label, TRACE information, and a link to open the
                            full trace page.
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
                            The point of those pieces is not to decorate the
                            answer. They give you places to look when you want
                            to understand what the answer is leaning on. A
                            source link can show where a claim came from. A
                            safety label can tell you that extra care may be
                            needed. TRACE is a compact picture of how the answer
                            was shaped. The trace link opens the fuller record.
                        </p>
                        <p>
                            If you open the trace page, you get more than a
                            short summary. You can see what ran, which steps
                            happened, and what sources were involved when they
                            were part of the answer. That still does not prove
                            the answer is right. What it gives you is something
                            real to inspect instead of a polished answer with no
                            paper trail.
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
                            Footnote is open source and still early. The core
                            ideas are here, but the project is still being
                            shaped, and a lot of the work ahead is about making
                            those ideas sturdier, clearer, and easier to use.
                        </p>
                        <p>
                            It is not just a web page or a demo. There is a
                            broader effort underneath it: more checkable
                            answers, more visible rules and defaults, more room
                            for user choice, and more practical paths for
                            self-hosting and provider choice.
                        </p>
                        <p>
                            You can run it from the repository and self-host it
                            with your own provider and infrastructure choices.
                            If you use hosted providers, their privacy and
                            retention rules still matter and should be reviewed
                            on their own terms.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="contribute"
                        aria-labelledby="contribute-title"
                    >
                        <h2 id="contribute-title">Contribute</h2>
                        <p>
                            There is room here for more than one kind of
                            contributor. Backend work matters. Frontend work
                            matters. Writing, diagrams, documentation, and the
                            hard job of making complicated ideas understandable
                            matter too.
                        </p>
                        <p>
                            If the project lines up with the questions you
                            already have about AI, start with the{' '}
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
