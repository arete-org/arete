// Section explaining ARETE's philosophy and commitment to ethical AI.
const Arete = (): JSX.Element => (
  <section className="arete" aria-labelledby="arete-title">
    <div className="arete-background" aria-hidden="true">
      {/* Symbolic constellation representing ARETE's ethical framework. */}
      <svg viewBox="0 0 320 120" role="presentation" focusable="false">
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
          alt="ARETE logo - a compass-like design with a capital A"
          className="arete-logo-image"
        />
      </div>
      <div className="arete-text">
        <p>
          You can host me yourself, invite me to Discord, and see how I work.
          I'm open-source, easy to modify, and built for privacy.
        </p>
        <div className="cta-group" aria-label="Primary actions">
          <a className="cta-button primary" href="/invite/" aria-label="Invite ARETE to Discord server">
            Invite to Discord <span aria-hidden="true">↗</span>
          </a>
          <a className="cta-button secondary" href="/blog" aria-label="View blog posts">
            Blog <span aria-hidden="true">↗</span>
          </a>
          <a className="cta-button secondary" href="https://github.com/arete-org/arete" target="_blank" rel="noreferrer" aria-label="View ARETE project on GitHub (opens in new tab)">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </div>
  </section>
);

export default Arete;
