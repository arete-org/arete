/**
 * @description: Renders the landing page hero content and primary calls to action for the web site.
 * @footnote-scope: web
 * @footnote-module: HeroSection
 * @footnote-risk: low - Hero regressions affect first impressions and CTA flow but do not break backend state.
 * @footnote-ethics: medium - The hero sets user expectations about privacy, honesty, and transparency.
 */

import AskMeAnything from './AskMeAnything';

// Hero banner introduces Footnote's tone and provides the primary calls to action.
const Hero = (): JSX.Element => (
    <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
            <h1 id="hero-title" className="hero-title">
                <span className="hero-title__line">Answers you can check.</span>
            </h1>
            <p className="hero-subheader">
                Footnote is an AI framework that tries to show its work.
            </p>
            <p className="hero-subheader">
                <span className="hero-subheader__line">Ask a question.</span>{' '}
                <span className="hero-subheader__line">
                    See the sources, choices, and limits behind the answer.
                </span>
            </p>
            <AskMeAnything />
        </div>
    </section>
);

export default Hero;
