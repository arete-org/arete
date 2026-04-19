/**
 * @description: Highlights the project commitments around openness, self-hosting, and licensing on the landing page.
 * @footnote-scope: web
 * @footnote-module: OpenAccountableSection
 * @footnote-risk: low - Copy or link regressions weaken a marketing section but do not affect core behavior.
 * @footnote-ethics: medium - This section communicates governance and transparency commitments that shape user trust.
 */

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
        title: 'Inspect the product, not just the promise',
        description:
            'Footnote shows answer-level provenance, safety signals, and trace links so you can verify what happened.',
        link: {
            href: 'https://github.com/footnote-ai/footnote/tree/main',
            label: 'Repository',
            external: true,
        },
    },
    {
        title: 'Run it yourself',
        description:
            'Self-hosting keeps your keys, runtime, and policy boundaries in your environment.',
        link: {
            href: '/invite/',
            label: 'Quickstart setup',
        },
    },
    {
        title: 'Open code with clear license terms',
        description:
            'Footnote is dual-licensed under MIT and Hippocratic License v3 (HL3-CORE).',
        link: {
            href: 'https://github.com/footnote-ai/footnote/blob/main/docs/LICENSE_STRATEGY.md',
            label: 'License strategy',
            external: true,
        },
    },
];

// Transparency block with three concise commitments.
const OpenAccountable = (): JSX.Element => (
    <section className="transparency" aria-labelledby="transparency-title">
        <h2 id="transparency-title">
            Why this is different from a normal chat box
        </h2>
        <div className="card-grid" role="list">
            {PRINCIPLES.map((principle) => (
                <article key={principle.title} className="card" role="listitem">
                    <h3>{principle.title}</h3>
                    <p>{principle.description}</p>
                    {principle.link && (
                        <a
                            href={principle.link.href}
                            target={
                                principle.link.external ? '_blank' : undefined
                            }
                            rel={
                                principle.link.external
                                    ? 'noopener noreferrer'
                                    : undefined
                            }
                            className="card-link"
                            aria-label={`${principle.link.label} (${principle.link.external ? 'opens in new tab' : ''})`}
                        >
                            {principle.link.label}
                            {principle.link.external && (
                                <span aria-hidden="true"> ↗</span>
                            )}
                        </a>
                    )}
                </article>
            ))}
        </div>
    </section>
);

export default OpenAccountable;
