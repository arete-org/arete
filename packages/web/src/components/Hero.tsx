import Header from './Header';
import AskMeAnything from './AskMeAnything';

// Hero banner introduces Footnote's tone and provides the primary calls to action.
const Hero = (): JSX.Element => {
    // No breadcrumbs on home page
    const breadcrumbItems: never[] = [];

    return (
        <section className="hero" aria-labelledby="hero-title">
            <Header breadcrumbItems={breadcrumbItems} />

            <div className="hero-copy">
                <h1 id="hero-title">Mindful and honest AI.</h1>
                <p className="hero-copy__subtitle">
                    Ethics-first, private, and easy to run yourself.
                </p>

                <div className="arete" aria-labelledby="arete-title">
                    <div className="arete-background" aria-hidden="true">
                        {/* Symbolic constellation representing Footnote's ethical framework. */}
                        <svg
                            viewBox="0 0 320 120"
                            role="presentation"
                            focusable="false"
                        >
                            <g className="arete-constellation">
                                <circle cx="30" cy="60" r="4" />
                                <circle cx="110" cy="30" r="3" />
                                <circle cx="200" cy="65" r="4" />
                                <circle cx="280" cy="40" r="3" />
                                <path d="M30 60 L110 30 L200 65 L280 40" />
                            </g>
                        </svg>
                    </div>
                    <div className="arete-content">
                        <div className="arete-logo">
                            <img
                                src="/assets/logo.jpg"
                                alt="Footnote logo - a compass-like design with a capital A"
                                className="arete-logo-image"
                            />
                        </div>
                        <div className="arete-text">
                            <h2 id="arete-title">I'm Arí,</h2>
                            <p>
                                I'm an AI built for clarity and care, not speed
                                or persuasion. I explain how I think, and
                                clearly show what I know and what I don't. You
                                can host me yourself, invite me to Discord, and
                                see how I work.
                            </p>
                        </div>
                    </div>
                </div>

                <AskMeAnything />
            </div>
        </section>
    );
};

export default Hero;
