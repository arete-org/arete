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
        title: '1. Prepare',
        description: 'Install dependencies and copy `.env.example` to `.env`.',
    },
    {
        title: '2. Deploy',
        description:
            'Set required secrets, including `OPENAI_API_KEY` and `INCIDENT_PSEUDONYMIZATION_SECRET`.',
    },
    {
        title: '3. Invite',
        description:
            'Run `pnpm dev` for web + backend, or `pnpm start:all` to include Discord.',
    },
];

// Section inviting operators to walk through the deployment steps at a human pace.
const Invite = (): JSX.Element => (
    <section className="invite" aria-labelledby="invite-title">
        <h2 id="invite-title">Run Footnote in your environment</h2>
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
            href="/invite/"
            aria-label="View setup instructions"
        >
            <span aria-hidden="true">🛠</span> Open Setup Guide
        </a>
    </section>
);

export default Invite;
