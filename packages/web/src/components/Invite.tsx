// Sequence describing how to self-host Footnote without losing control of the infrastructure.
interface InviteStep {
    title: string;
    description: string;
}

const STEPS: InviteStep[] = [
    {
        title: '1. Prepare',
        description:
            'Create a Discord bot, add your API keys, and configure personality and rules.',
    },
    {
        title: '2. Deploy',
        description:
            'Run the Node server locally or deploy it to Fly.io using the provided configuration.',
    },
    {
        title: '3. Invite',
        description:
            'Add the bot to your Discord server and start the conversation!',
    },
];

// Section inviting operators to walk through the deployment steps at a human pace.
const Invite = (): JSX.Element => (
    <section className="invite" aria-labelledby="invite-title">
        <h2 id="invite-title">Invite Footnote to your server</h2>
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
            <span aria-hidden="true">🛠</span> Setup Instructions
        </a>
    </section>
);

export default Invite;
