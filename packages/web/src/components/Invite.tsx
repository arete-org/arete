/**
 * @description: Presents the short invite and self-hosting steps on the landing page.
 * @footnote-scope: web
 * @footnote-module: InviteSection
 * @footnote-risk: low - Incorrect copy or links can confuse setup expectations but do not affect runtime state.
 * @footnote-ethics: medium - Self-hosting guidance shapes operator understanding of control, privacy, and deployment choices.
 */

// Sequence describing how to self-host Footnote without losing control of the infrastructure.
interface InviteStep {
    title: string;
    description: string;
}

const STEPS: InviteStep[] = [
    {
        title: '1. Read the source',
        description:
            'Start from the GitHub README for the current install path and required tools.',
    },
    {
        title: '2. Configure',
        description:
            'Set required environment values for your provider and runtime.',
    },
    {
        title: '3. Run locally',
        description:
            'Use the documented `pnpm` commands for web, backend, and optional Discord.',
    },
];

// Section inviting operators to walk through the deployment steps at a human pace.
const Invite = (): JSX.Element => (
    <section className="invite" aria-labelledby="invite-title">
        <h2 id="invite-title">Get started today</h2>
        <div className="card-grid" role="list">
            {STEPS.map((step) => (
                <article key={step.title} className="card" role="listitem">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                </article>
            ))}
        </div>
        <a
            className="inline-cta"
            href="https://github.com/footnote-ai/footnote/blob/main/README.md"
            target="_blank"
            rel="noreferrer"
            aria-label="Open setup instructions on GitHub (opens in new tab)"
        >
            <span aria-hidden="true">↗</span> Open Setup Guide on GitHub
        </a>
    </section>
);

export default Invite;
