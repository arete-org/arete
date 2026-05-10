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
    | 'why-footnote-exists'
    | 'reading-a-response'
    | 'what-the-trace-shows'
    | 'limits'
    | 'project-status'
    | 'contributing';

type SectionLink = {
    id: AboutSectionId;
    label: string;
};

const sectionLinks: SectionLink[] = [
    { id: 'why-footnote-exists', label: 'Why Footnote exists' },
    { id: 'reading-a-response', label: 'Reading a response' },
    { id: 'what-the-trace-shows', label: 'What the trace shows' },
    { id: 'limits', label: 'Limits' },
    { id: 'project-status', label: 'Project status' },
    { id: 'contributing', label: 'Contributing' },
];

const AboutPage = (): JSX.Element => (
    <>
        <Header />
        <main className="page-content" id="main-content">
            <header className="page-hero" aria-labelledby="about-title">
                <h1 id="about-title">AI that carries receipts.</h1>
                <p className="page-hero__summary">
                    Footnote is an attempt to make AI answers easier to inspect,
                    question, and challenge.
                </p>
                <p>
                    AI can be useful and still leave you uneasy about what to
                    trust. Footnote is pre-1.0 and under active development. It
                    does not solve that problem, but it tries to leave more of
                    the trail attached to the answer.
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
                        id="why-footnote-exists"
                        aria-labelledby="why-footnote-exists-title"
                    >
                        <h2 id="why-footnote-exists-title">
                            Why Footnote exists
                        </h2>
                        <p>
                            A lot of AI tools are built to keep the interaction
                            smooth. You ask a question, get a polished answer,
                            and move on. The problem is that the smoothness can
                            hide a lot. You may not know where the answer came
                            from, how much it relied on outside material, or
                            what changed between the question you asked and the
                            answer you got back.
                        </p>
                        <p>
                            That uncertainty is not just a technical flaw. It
                            changes the relationship between the person and the
                            answer. A system that sounds sure of itself can make
                            it easy to slide from usefulness into unearned
                            trust, especially when there is very little for the
                            reader to inspect.
                        </p>
                        <p>
                            Footnote starts from the idea that this uncertainty
                            matters. The goal is not to make AI feel magical. It
                            is to make it easier to look at a response and ask:
                            what is this answer standing on, and how much
                            confidence should I place in it?
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
                            Footnote is built around the answer, but not around
                            the answer alone. When sources are available, it can
                            show them. It can also show a safety tier and a link
                            to the trace for that response.
                        </p>
                        <p>
                            Each of those pieces is there for a reason. Sources
                            help you follow specific claims back to something
                            outside the assistant. A safety tier is a signal
                            about the posture of the response, not a stamp of
                            truth. The trace is where you go when the surface
                            answer is not enough.
                        </p>
                        <p>
                            Those details are there to slow the experience down
                            in a useful way. Instead of treating the response as
                            a finished product, the page gives you a few handles
                            for checking what kind of answer you are looking at
                            and whether it deserves more scrutiny.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="what-the-trace-shows"
                        aria-labelledby="what-the-trace-shows-title"
                    >
                        <h2 id="what-the-trace-shows-title">
                            What the trace shows
                        </h2>
                        <p>
                            The trace is the place to look when you want more
                            than the surface answer. It can show what model ran,
                            which workflow steps happened, and which outside
                            sources were used when they were part of the run.
                        </p>
                        <p>
                            That matters because it replaces some of the usual
                            black-box feeling with a visible record. Instead of
                            being asked to trust the answer because it arrived
                            fluently, you have something to examine when you
                            need to understand how it came together.
                        </p>
                        <p>
                            That record does not prove the answer is correct.
                            What it does is give you something concrete to
                            inspect. If a claim feels shaky, the trace gives you
                            a better starting point than a blank box and a
                            confident tone.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="limits"
                        aria-labelledby="limits-title"
                    >
                        <h2 id="limits-title">Limits</h2>
                        <p>
                            Footnote is not a replacement for judgment. It is
                            not a guarantee that an answer is true, fair, or
                            complete. It is also not a substitute for checking
                            important claims yourself when the stakes are high.
                        </p>
                        <p>
                            The project is trying to make AI answers less
                            opaque, not to remove the need for human judgment.
                            If Footnote is doing its job well, it should make it
                            easier to question a response rather than easier to
                            surrender to it.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="project-status"
                        aria-labelledby="project-status-title"
                    >
                        <h2 id="project-status-title">Project status</h2>
                        <p>
                            Footnote is open source and still early. The core
                            idea is here: responses can carry sources, traces,
                            and other context that make them easier to examine.
                            But the project is still being shaped, and there is
                            a lot of room to improve both the experience and the
                            underlying systems.
                        </p>
                        <p>
                            The direction is broader than one interface. The aim
                            is to make AI behavior more inspectable, leave more
                            room for user choice, and rely less on opaque
                            defaults that ask people to accept too much on
                            faith.
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
                        id="contributing"
                        aria-labelledby="contributing-title"
                    >
                        <h2 id="contributing-title">Contributing</h2>
                        <p>
                            Useful contributions are not limited to model or
                            backend work. Clearer docs, better trace UX,
                            stronger review flows, and sharper product writing
                            all matter here.
                        </p>
                        <p>
                            The project also benefits from people who care about
                            accountability, legibility, and how trust is earned
                            in real interfaces, not just from people who want to
                            tune models or ship features quickly.
                        </p>
                        <p>
                            If the project feels aligned with the questions you
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
