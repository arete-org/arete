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
import StickySectionToc from '@components/StickySectionToc';
import { Link } from 'react-router-dom';

type AboutSectionId =
    | 'why-footnote-exists'
    | 'reading-a-response'
    | 'what-a-trace-is'
    | 'open-source-and-self-hosting'
    | 'developers';

type SectionLink = {
    id: AboutSectionId;
    label: string;
};

const sectionLinks: SectionLink[] = [
    { id: 'why-footnote-exists', label: 'A better way to read AI' },
    { id: 'reading-a-response', label: 'Inside a response' },
    { id: 'what-a-trace-is', label: 'The record' },
    {
        id: 'open-source-and-self-hosting',
        label: 'Open source',
    },
    { id: 'developers', label: 'Get involved' },
];

const AboutPage = (): JSX.Element => (
    <>
        <Header />
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
                            Open source
                        </h2>
                        <p>
                            Footnote is open source and built to run outside the
                            hosted demo. You can try the browser demo, run your
                            own copy from the repo, or self-host it with your
                            own setup.
                        </p>
                        <p>
                            If you use hosted model providers (e.g. Ollama
                            cloud, OpenAI), ensure you understand their privacy
                            and retention rules.
                        </p>
                    </section>

                    <section
                        className="page-section"
                        id="developers"
                        aria-labelledby="developers-title"
                    >
                        <h2 id="developers-title">Get involved</h2>
                        <p>Want to help us work on Footnote?</p>
                        <p>
                            <Link to="/onboarding">Start here</Link>!
                        </p>
                    </section>
                </article>
            </div>
        </main>
        <Footer />
    </>
);

export default AboutPage;
