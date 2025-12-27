// Pillars emphasising openness so future contributors understand the governance philosophy.
interface Principle {
  title: string;
  description: string;
  link?: {
    href: string;
    label: string;
    external?: boolean;
  };
}

const PRINCIPLES: Principle[] = [
  {
    title: 'Open source',
    description:
      'Everything\'s in the open. Explore the code, learn from it, or make it your own.',
    link: {
      href: 'https://github.com/arete-org/arete/tree/main',
      label: 'Source code',
      external: true,
    },
  },
  {
    title: 'Self-hosted first',
    description:
      'You own the keys and decide where Ari lives. Your server, your rules.',
    link: {
      href: '/invite/',
      label: 'Setup instructions',
    },
  },
  {
    title: 'Dual license',
    description:
      'MIT + Hippocratic — open for everyone, grounded in ethics.',
    link: {
      href: 'https://github.com/arete-org/arete/blob/main/docs/LICENSE_STRATEGY.md',
      label: 'Licensing',
      external: true,
    },
  },
];

// Transparency block with three concise commitments.
const OpenAccountable = (): JSX.Element => (
  <section className="transparency" aria-labelledby="transparency-title">
    <h2 id="transparency-title">Open and accountable</h2>
    <div className="card-grid" role="list">
      {PRINCIPLES.map((principle) => (
        <article key={principle.title} className="card" role="listitem">
          <h3>{principle.title}</h3>
          <p>{principle.description}</p>
          {principle.link && (
            <a
              href={principle.link.href}
              target={principle.link.external ? '_blank' : undefined}
              rel={principle.link.external ? 'noopener noreferrer' : undefined}
              className="card-link"
              aria-label={`${principle.link.label} (${principle.link.external ? 'opens in new tab' : ''})`}
            >
              {principle.link.label}
              {principle.link.external && <span aria-hidden="true"> ↗</span>}
            </a>
          )}
        </article>
      ))}
    </div>
  </section>
);

export default OpenAccountable;
