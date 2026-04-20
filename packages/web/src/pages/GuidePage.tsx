/**
 * @description: Renders the Footnote engineering guide for contributors who
 * need a quick, current map of the repo and runtime.
 * @footnote-scope: web
 * @footnote-module: GuidePage
 * @footnote-risk: low - Incorrect guide copy can mislead contributors about package ownership and request flow.
 * @footnote-ethics: medium - This page shapes contributor understanding of provenance, trace, and backend-owned controls.
 */

import type { ReactNode } from 'react';
import Header from '@components/Header';
import Footer from '@components/Footer';

type GuideSectionId =
    | 'what-footnote-is'
    | 'repo-map'
    | 'request-flow'
    | 'runtime-boundaries'
    | 'workflow-planner-trace'
    | 'trustgraph'
    | 'current-migrations'
    | 'common-mistakes'
    | 'further-reading';

type GuideJumpLink = {
    id: GuideSectionId;
    label: string;
};

type RepoMapEntry = {
    name: string;
    description: string;
};

type ReadingLink = {
    href: string;
    label: string;
    description: string;
};

const breadcrumbItems = [{ label: 'Engineering Guide' }];

const guideJumpLinks: GuideJumpLink[] = [
    { id: 'what-footnote-is', label: 'What Footnote is' },
    { id: 'repo-map', label: 'Repo map' },
    { id: 'request-flow', label: 'Request flow' },
    { id: 'runtime-boundaries', label: 'Runtime boundaries' },
    { id: 'workflow-planner-trace', label: 'Workflow, planner, and trace' },
    { id: 'trustgraph', label: 'TrustGraph' },
    { id: 'current-migrations', label: 'Current migrations' },
    { id: 'common-mistakes', label: 'Common mistakes' },
    { id: 'further-reading', label: 'Further reading' },
];

const repoMapEntries: RepoMapEntry[] = [
    {
        name: 'packages/backend',
        description:
            'Main runtime. Owns request routing, planner and workflow decisions, prompt assembly, traces, incidents, and cost records.',
    },
    {
        name: 'packages/agent-runtime',
        description:
            'Provider adapter layer. Translates Footnote generation requests to vendor runtimes and returns normalized results.',
    },
    {
        name: 'packages/contracts',
        description:
            'Shared request, response, and metadata contracts. If you change shapes here, expect backend, web, and Discord to move with it.',
    },
    {
        name: 'packages/api-client',
        description:
            'Typed client helpers for calling Footnote APIs from other packages.',
    },
    {
        name: 'packages/web',
        description:
            'Browser app. Renders chat, traces, blog, and setup pages. It calls backend APIs and does not own generation rules.',
    },
    {
        name: 'packages/discord-bot',
        description:
            'Discord surface for chat, commands, and voice. It uses backend-owned APIs instead of making product decisions on the edge.',
    },
    {
        name: 'packages/prompts',
        description:
            'Shared prompt assets and registry code. Use this package when a prompt change must stay aligned across runtimes.',
    },
    {
        name: 'docs',
        description:
            'Architecture notes, decision records, and status docs. Start with the architecture reading guide, then check status notes for rollout context.',
    },
];

const repoBaseUrl = 'https://github.com/footnote-ai/footnote/blob/main';

const furtherReadingLinks: ReadingLink[] = [
    {
        href: `${repoBaseUrl}/README.md`,
        label: 'README',
        description:
            'Start here for local setup and the top-level product summary.',
    },
    {
        href: `${repoBaseUrl}/docs/architecture/README.md`,
        label: 'Architecture reading guide',
        description:
            'Best first stop for current architecture docs and the recommended reading order.',
    },
    {
        href: `${repoBaseUrl}/docs/architecture/execution-contract-authority-map.md`,
        label: 'Execution Contract authority map',
        description: 'Shows which part owns each decision in chat execution.',
    },
    {
        href: `${repoBaseUrl}/docs/architecture/workflow-mode-routing.md`,
        label: 'Workflow mode routing',
        description:
            'Explains how fast, balanced, and grounded modes map to runtime behavior.',
    },
    {
        href: `${repoBaseUrl}/docs/architecture/workflow-engine-and-provenance.md`,
        label: 'Workflow engine and provenance',
        description:
            'Covers the reviewed workflow path and the records it emits.',
    },
    {
        href: `${repoBaseUrl}/docs/architecture/execution_contract_trustgraph/architecture.md`,
        label: 'TrustGraph architecture',
        description:
            'Detailed TrustGraph seam rules, constraints, and rollout guardrails.',
    },
    {
        href: `${repoBaseUrl}/docs/status/2026-04-workflow-engine-rollout-status.md`,
        label: 'Workflow engine rollout status',
        description:
            'Current rollout note for the workflow engine. Use it for current status, not first-pass architecture.',
    },
    {
        href: `${repoBaseUrl}/docs/ai/README.md`,
        label: 'AI assistance guide',
        description:
            'Short contributor guide for using AI tools in this repo without drifting from project rules.',
    },
];

const renderFlowStep = (title: string, body: ReactNode): JSX.Element => (
    <li className="guide-flow__item">
        <p className="guide-flow__title">{title}</p>
        <p>{body}</p>
    </li>
);

const GuidePage = (): JSX.Element => (
    <>
        <Header breadcrumbItems={breadcrumbItems} />
        <main className="guide-page" id="main-content">
            <section className="guide-hero" aria-labelledby="guide-title">
                <p className="guide-eyebrow">Engineering Guide</p>
                <h1 id="guide-title">Footnote engineering guide</h1>
                <p className="guide-summary">
                    Footnote is a backend, web app, and Discord bot for AI
                    responses you can inspect after the fact. The backend
                    decides how a request runs, which workflow and model profile
                    to use, which tools are allowed, and what trace data gets
                    recorded.
                </p>
                <nav className="guide-jump-nav" aria-label="Guide sections">
                    <ul className="guide-jump-list">
                        {guideJumpLinks.map((link) => (
                            <li key={link.id}>
                                <a href={`#${link.id}`}>{link.label}</a>
                            </li>
                        ))}
                    </ul>
                </nav>
            </section>

            <section
                className="guide-section"
                id="what-footnote-is"
                aria-labelledby="what-footnote-is-title"
            >
                <h2 id="what-footnote-is-title">What Footnote is</h2>
                <p>
                    The backend is the real executor. Models generate text, but
                    the backend decides the rules around that generation:
                    request normalization, planner use, workflow limits, tool
                    access, trace recording, and response metadata.
                </p>
                <p>
                    That is the main repo habit to keep in mind. If a change is
                    deciding what the system should do, it probably belongs in
                    `packages/backend`, not in a provider adapter, the web app,
                    or the Discord bot.
                </p>
            </section>

            <section
                className="guide-section"
                id="repo-map"
                aria-labelledby="repo-map-title"
            >
                <h2 id="repo-map-title">Repo map</h2>
                <dl className="guide-map">
                    {repoMapEntries.map((entry) => (
                        <div className="guide-map__row" key={entry.name}>
                            <dt>{entry.name}</dt>
                            <dd>{entry.description}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <section
                className="guide-section"
                id="request-flow"
                aria-labelledby="request-flow-title"
            >
                <h2 id="request-flow-title">Request flow</h2>
                <ol className="guide-flow">
                    {renderFlowStep(
                        '1. Request enters backend',
                        <>
                            `server.ts` boots services. `handlers/chat.ts`
                            handles HTTP concerns such as auth, rate limiting,
                            and request normalization.
                        </>
                    )}
                    {renderFlowStep(
                        '2. Orchestrator decides the run',
                        <>
                            `chatOrchestrator.ts` applies safety checks, planner
                            output, profile overlays, tool rules, and runtime
                            routing before handing off execution.
                        </>
                    )}
                    {renderFlowStep(
                        '3. Chat service executes',
                        <>
                            `chatService.ts` builds the generation request, runs
                            either direct generation or the workflow path,
                            records usage and cost, and assembles public
                            metadata.
                        </>
                    )}
                    {renderFlowStep(
                        '4. Provider runtime returns normalized output',
                        <>
                            `packages/agent-runtime` talks to provider APIs and
                            returns citations and result data in Footnote-owned
                            shapes.
                        </>
                    )}
                    {renderFlowStep(
                        '5. Trace is stored and rendered',
                        <>
                            The backend writes trace data. The web app later
                            renders it on the trace page, and Discord can show a
                            smaller provenance view inline.
                        </>
                    )}
                </ol>
            </section>

            <section
                className="guide-section"
                id="runtime-boundaries"
                aria-labelledby="runtime-boundaries-title"
            >
                <h2 id="runtime-boundaries-title">Runtime boundaries</h2>
                <ul className="guide-list">
                    <li>
                        Backend owns policy, workflow legality, trace records,
                        and cost recording.
                    </li>
                    <li>
                        Provider adapters translate requests and responses. They
                        should not decide product behavior.
                    </li>
                    <li>
                        `packages/contracts` owns serializable public shapes.
                        Treat contract edits as cross-package changes.
                    </li>
                    <li>
                        Web and Discord are clients. They can choose
                        presentation, but they should not replace backend
                        decisions with local ones.
                    </li>
                </ul>
            </section>

            <section
                className="guide-section"
                id="workflow-planner-trace"
                aria-labelledby="workflow-planner-trace-title"
            >
                <h2 id="workflow-planner-trace-title">
                    Workflow, planner, and trace
                </h2>
                <p>
                    The current reviewed path is a bounded workflow loop. The
                    main step pattern is `generate`, `assess`, and `revise`,
                    with backend limits controlling step count, deliberation,
                    and duration.
                </p>
                <p>
                    The planner is still separate from the workflow engine in
                    the main chat path. It runs before workflow execution and
                    can suggest action details, but it does not get to change
                    the backend rules.
                </p>
                <p>
                    Trace data is a first-class output. The response metadata
                    and stored trace should let you answer basic review
                    questions later: which mode ran, which workflow profile was
                    selected, which tools were used, and what evidence or
                    citations were attached.
                </p>
            </section>

            <section
                className="guide-section"
                id="trustgraph"
                aria-labelledby="trustgraph-title"
            >
                <h2 id="trustgraph-title">TrustGraph</h2>
                <p>
                    TrustGraph is an advisory evidence seam under backend
                    control. It can add evidence and provenance detail, but it
                    does not become the authority for routing or final output.
                </p>
                <ul className="guide-list">
                    <li>
                        Backend validates scope and ownership before using
                        TrustGraph data.
                    </li>
                    <li>
                        Retrieval and tenancy checks stay strict. User-facing
                        continuity stays fail-open when external retrieval has a
                        problem.
                    </li>
                    <li>
                        The mapping registry only allows registered TrustGraph
                        fields to affect backend predicate views.
                    </li>
                </ul>
            </section>

            <section
                className="guide-section"
                id="current-migrations"
                aria-labelledby="current-migrations-title"
            >
                <h2 id="current-migrations-title">Current migrations</h2>
                <ul className="guide-list">
                    <li>
                        The active rollout note is the workflow engine rollout.
                        The reviewed chat path now uses the shared engine shape,
                        but planner-as-workflow-step and tool-step expansion are
                        still open work.
                    </li>
                    <li>
                        Legacy OpenAI removal is mostly a history topic now.
                        Text, image, and voice have been moved behind backend or
                        internal Footnote seams, but some cleanup debt and old
                        naming still remain.
                    </li>
                    <li>
                        Prompt and rule consolidation is already reflected in
                        the repo layout: `packages/prompts` is the shared prompt
                        home, and `AGENTS.md` is the canonical agent rule file.
                    </li>
                </ul>
            </section>

            <section
                className="guide-section"
                id="common-mistakes"
                aria-labelledby="common-mistakes-title"
            >
                <h2 id="common-mistakes-title">Common mistakes</h2>
                <ul className="guide-list">
                    <li>
                        Putting policy or routing logic in `packages/web`,
                        `packages/discord-bot`, or provider adapters.
                    </li>
                    <li>
                        Trusting a status note over the source when they
                        disagree. Status docs help with rollout context, but the
                        code is the final answer.
                    </li>
                    <li>
                        Assuming planner output is already safe to use as-is.
                        The backend still normalizes and bounds planner output.
                    </li>
                    <li>
                        Trying to make every failure path identical. Some paths
                        are intentionally fail-open for continuity, while scope
                        and ownership checks stay strict.
                    </li>
                    <li>
                        Changing shared contracts without checking every caller
                        and trace surface that depends on them.
                    </li>
                </ul>
            </section>

            <section
                className="guide-section"
                id="further-reading"
                aria-labelledby="further-reading-title"
            >
                <h2 id="further-reading-title">Further reading</h2>
                <ul className="guide-links">
                    {furtherReadingLinks.map((link) => (
                        <li key={link.href}>
                            <a
                                href={link.href}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {link.label} <span aria-hidden="true">↗</span>
                            </a>
                            <p>{link.description}</p>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
        <Footer />
    </>
);

export default GuidePage;
